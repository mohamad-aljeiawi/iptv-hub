// Syncing with upstream servers: metadata only, never video.
import { db, serverById, base, cleanupOrphans, kvCache } from './db.js';
import { UA } from './config.js';
import { parseName, parseCategory, nameKeyOf, tmdbKeyOf } from './normalize.js';
import { clearCaches } from './http.js';

// ───────────────────────── Xtream client ─────────────────────────
export async function xt(server, params = {}, timeout = 60000) {
  const u = new URL(base(server) + '/player_api.php');
  u.searchParams.set('username', server.username);
  u.searchParams.set('password', server.password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const t0 = Date.now();
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return { j, ms: Date.now() - t0 };
}

// Servers that are currently down, and servers being synced right now.
export const down = new Set();
export const syncing = new Set();

let queue = Promise.resolve();
export function scheduleSync(id) {
  if (syncing.has(id)) return;
  syncing.add(id);
  queue = queue.then(() => syncServer(id)).finally(() => syncing.delete(id));
}

export async function syncServer(id) {
  const s = serverById(id);
  if (!s) return;
  const t0 = Date.now();
  try {
    const { j: auth, ms } = await xt(s, {}, 20000);
    const ui = auth.user_info || {};
    if (ui.auth === 0 || (ui.status && ui.status !== 'Active')) throw new Error('account is not active: ' + (ui.status || 'login failed'));
    const data = {};
    for (const [type, catAction, listAction] of [
      ['live', 'get_live_categories', 'get_live_streams'],
      ['vod', 'get_vod_categories', 'get_vod_streams'],
      ['series', 'get_series_categories', 'get_series'],
    ]) {
      const cats = (await xt(s, { action: catAction })).j;
      const list = (await xt(s, { action: listAction }, 240000)).j;
      data[type] = { cats: Array.isArray(cats) ? cats : [], list: Array.isArray(list) ? list : [] };
    }
    const n = ingest(s.id, data);
    db.prepare('UPDATE servers SET status=?, exp_date=?, max_conn=?, latency=?, last_sync=?, error=NULL WHERE id=?')
      .run(ui.status || 'Active', +ui.exp_date || null, +ui.max_connections || null, ms, Date.now(), s.id);
    down.delete(s.id);
    console.log(`ok  ${s.name}: ${n} items in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    db.prepare('UPDATE servers SET error=?, last_sync=? WHERE id=?').run(String(e.message || e), Date.now(), id);
    console.log(`err ${s.name}: ${e.message}`);
  }
}

// ───────────────────────── ingest and de-duplicate ─────────────────────────
export function ingest(serverId, data) {
  const keyGet = db.prepare('SELECT item_id FROM keys WHERE key=?');
  const keyPut = db.prepare('INSERT OR IGNORE INTO keys(key,item_id) VALUES(?,?)');
  const itemTmdb = db.prepare('SELECT tmdb FROM items WHERE id=?');
  const insItem = db.prepare('INSERT INTO items(type,title,norm,year,tmdb,poster,rating,added,category_id,ext,epg) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const updItem = db.prepare(`UPDATE items SET poster=COALESCE(poster,?), tmdb=COALESCE(tmdb,?), year=COALESCE(NULLIF(year,''),?),
    rating=MAX(COALESCE(rating,0),?), added=MAX(COALESCE(added,0),?), category_id=COALESCE(category_id,?),
    ext=COALESCE(ext,?), epg=COALESCE(NULLIF(epg,''),?) WHERE id=?`);
  const insFts = db.prepare('INSERT INTO fts(rowid,norm) VALUES(?,?)');
  const insSrc = db.prepare('INSERT OR REPLACE INTO sources(item_id,server_id,type,stream_id,ext,raw_name,category,quality,epg) VALUES(?,?,?,?,?,?,?,?,?)');
  const catGet = db.prepare('SELECT id FROM categories WHERE type=? AND norm=?');
  const catIns = db.prepare('INSERT INTO categories(type,name,norm) VALUES(?,?,?)');
  const catCache = new Map();
  const catOf = (type, name) => {   // similar categories from different servers collapse into one
    const c = parseCategory(name); if (!c) return null;
    const k = type + '|' + c.norm;
    if (!catCache.has(k)) catCache.set(k, catGet.get(type, c.norm)?.id ?? Number(catIns.run(type, c.title, c.norm).lastInsertRowid));
    return catCache.get(k);
  };
  let count = 0;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sources WHERE server_id=?').run(serverId);
    for (const type of ['live', 'vod', 'series']) {
      const catMap = new Map((data[type]?.cats || []).map(c => [String(c.category_id), c.category_name]));
      for (const x of data[type]?.list || []) {
        const raw = x.name ?? x.title ?? '';
        const p = parseName(raw, type);
        const sid = type === 'series' ? x.series_id : x.stream_id;
        if (!p || sid == null) continue;
        const tmdb = parseInt(x.tmdb || x.tmdb_id) || null;
        const year = p.year || String(x.year || x.releaseDate || x.release_date || '').slice(0, 4) || '';
        const poster = x.stream_icon || x.cover || null;
        const rating = parseFloat(x.rating_5based) * 2 || parseFloat(x.rating) || 0;
        const added = parseInt(x.added || x.last_modified) || 0;
        const catName = catMap.get(String(x.category_id)) || null;
        const catId = catOf(type, catName);
        const ext = x.container_extension || null, epg = x.epg_channel_id || null;

        // Merge key: TMDB first, then clean name + year.
        const nameKey = nameKeyOf(type, p.norm, year);
        const tmdbKey = tmdbKeyOf(type, tmdb);
        let itemId = tmdbKey && keyGet.get(tmdbKey)?.item_id;
        if (!itemId) {
          const hit = keyGet.get(nameKey)?.item_id;
          if (hit) { const t = itemTmdb.get(hit)?.tmdb; if (!tmdb || !t || t === tmdb) itemId = hit; }
        }
        if (itemId) updItem.run(poster, tmdb, year, rating, added, catId, ext, epg, itemId);
        else {
          itemId = Number(insItem.run(type, p.title, p.norm, year, tmdb, poster, rating, added, catId, ext, epg).lastInsertRowid);
          insFts.run(itemId, p.norm);
        }
        keyPut.run(nameKey, itemId);
        if (tmdbKey) keyPut.run(tmdbKey, itemId);
        insSrc.run(itemId, serverId, type, String(sid), ext, raw, catName, p.quality, epg);
        count++;
      }
    }
    cleanupOrphans();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  clearCaches();
  return count;
}

// ───────────────────────── health checks ─────────────────────────
export async function healthCheck() {
  for (const s of db.prepare('SELECT * FROM servers').all()) {
    try {
      const { j, ms } = await xt(s, {}, 8000);
      if (j?.user_info?.auth === 0) throw new Error('auth');
      down.delete(s.id);
      db.prepare('UPDATE servers SET latency=? WHERE id=?').run(ms, s.id);
    } catch { down.add(s.id); }
  }
}

export function refreshStale(hours) {
  const cutoff = Date.now() - hours * 3600e3;
  for (const s of db.prepare('SELECT id FROM servers WHERE last_sync IS NULL OR last_sync < ?').all(cutoff)) scheduleSync(s.id);
}

// ───────────────────────── upstream series metadata ─────────────────────────
async function seriesRaw(src) {
  return kvCache(`sraw:${src.server_id}:${src.stream_id}`, 12 * 3600e3, async () =>
    (await xt(serverById(src.server_id), { action: 'get_series_info', series_id: src.stream_id }, 15000)).j);
}

export function flatEpisodes(j) {
  const raw = j?.episodes || {};
  const entries = Array.isArray(raw) ? raw.map((e, i) => [String(i + 1), e]) : Object.entries(raw);
  const out = [];
  for (const [sn, eps] of entries) {
    const arr = Array.isArray(eps) ? eps : Object.values(eps || {});
    arr.forEach((e, i) => e && out.push({ ...e, _season: +(e.season || sn) || 1, _num: +e.episode_num || i + 1 }));
  }
  return out;
}

export async function episodesOf(src) {
  const m = new Map();
  for (const e of flatEpisodes(await seriesRaw(src))) m.set(`${e._season}:${e._num}`, { id: String(e.id), ext: e.container_extension || 'mp4' });
  return m;
}

export { seriesRaw };
