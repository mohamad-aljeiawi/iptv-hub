// The Xtream API that players talk to (TiviMate, IPTV Smarters, ...).
import { db, serverById, base, itemById, checkUser, kvCache } from './db.js';
import { UNCAT, UNCAT_NAME } from './config.js';
import { send, sendCached, redirect, cached, origin, onClear, lru } from './http.js';
import { xt, seriesRaw, flatEpisodes } from './sync.js';
import { ranked, resolve, vepIns, vepFind } from './resolve.js';

// ───────────────────────── listings ─────────────────────────
export function categoriesOf(type) {
  const rows = db.prepare('SELECT id, name FROM categories WHERE type=? ORDER BY id').all(type)
    .map(c => ({ category_id: String(c.id), category_name: c.name, parent_id: 0 }));
  if (db.prepare('SELECT 1 FROM items WHERE type=? AND category_id IS NULL LIMIT 1').get(type))
    rows.push({ category_id: String(UNCAT), category_name: UNCAT_NAME, parent_id: 0 });
  return rows;
}

export function streamsOf(type, cat) {
  const where = cat ? (+cat === UNCAT ? 'AND i.category_id IS NULL' : 'AND i.category_id=?') : '';
  const args = cat && +cat !== UNCAT ? [type, +cat] : [type];
  const rows = db.prepare(`SELECT id, title, year, poster, rating, tmdb, added, category_id, ext, epg FROM items i
    WHERE i.type=? ${where} ORDER BY i.category_id, i.id`).all(...args);
  return rows.map((r, n) => {
    const cid = String(r.category_id ?? UNCAT);
    const rating = r.rating ? { rating: String(r.rating), rating_5based: +(r.rating / 2).toFixed(1) } : { rating: '', rating_5based: 0 };
    const name = type !== 'live' && r.year ? `${r.title} (${r.year})` : r.title;
    if (type === 'live') return { num: n + 1, name, stream_type: 'live', stream_id: r.id, stream_icon: r.poster || '', epg_channel_id: r.epg || '',
      added: String(r.added || 0), category_id: cid, category_ids: [+cid], custom_sid: '', tv_archive: 0, direct_source: '', tv_archive_duration: 0 };
    if (type === 'vod') return { num: n + 1, name, stream_type: 'movie', stream_id: r.id, stream_icon: r.poster || '', ...rating,
      tmdb: r.tmdb ? String(r.tmdb) : '', added: String(r.added || 0), category_id: cid, category_ids: [+cid],
      container_extension: r.ext || 'mp4', custom_sid: '', direct_source: '' };
    return { num: n + 1, name, series_id: r.id, cover: r.poster || '', plot: '', cast: '', director: '', genre: '', releaseDate: r.year || '',
      last_modified: String(r.added || 0), ...rating, backdrop_path: [], youtube_trailer: '', episode_run_time: '',
      category_id: cid, category_ids: [+cid], tmdb: r.tmdb ? String(r.tmdb) : '' };
  });
}

// Pre-build the big listings after every sync so the first player request is fast.
let warmTimer;
export function warm() {
  for (const t of ['live', 'vod', 'series']) { cached(`cat:${t}`, () => categoriesOf(t)); cached(`${t}:`, () => streamsOf(t)); }
}
onClear(() => { clearTimeout(warmTimer); warmTimer = setTimeout(warm, 500); warmTimer.unref?.(); });

export function authInfo(user, req) {
  const o = new URL(origin(req)), https = o.protocol === 'https:';
  return {
    user_info: { username: user.username, password: user.password, message: '', auth: 1, status: 'Active',
      exp_date: user.exp_date ? String(user.exp_date) : null, is_trial: '0', active_cons: '0',
      created_at: String(Math.floor((user.created || Date.now()) / 1000)), max_connections: String(user.max_conn || 1),
      allowed_output_formats: ['m3u8', 'ts'] },
    server_info: { url: o.hostname, port: o.port || (https ? '443' : '80'), https_port: https ? (o.port || '443') : '',
      server_protocol: https ? 'https' : 'http', rtmp_port: '', timezone: 'UTC', timestamp_now: Math.floor(Date.now() / 1000),
      time_now: new Date().toISOString().slice(0, 19).replace('T', ' ') },
  };
}

export function m3uPlaylist(user, req, output) {
  const o = origin(req), U = encodeURIComponent(user.username), P = encodeURIComponent(user.password);
  const cats = new Map(db.prepare('SELECT id, name FROM categories').all().map(c => [String(c.id), c.name]));
  const clean = s => String(s || '').replace(/["\r\n]/g, ' ');
  const ext = output === 'm3u8' || output === 'hls' ? 'm3u8' : 'ts';
  const out = ['#EXTM3U'];
  for (const r of streamsOf('live')) out.push(
    `#EXTINF:-1 tvg-id="${clean(r.epg_channel_id)}" tvg-name="${clean(r.name)}" tvg-logo="${clean(r.stream_icon)}" group-title="${clean(cats.get(r.category_id) || UNCAT_NAME)}",${clean(r.name)}`,
    `${o}/live/${U}/${P}/${r.stream_id}.${ext}`);
  for (const r of streamsOf('vod')) out.push(
    `#EXTINF:-1 tvg-name="${clean(r.name)}" tvg-logo="${clean(r.stream_icon)}" group-title="${clean(cats.get(r.category_id) || UNCAT_NAME)}",${clean(r.name)}`,
    `${o}/movie/${U}/${P}/${r.stream_id}.${r.container_extension}`);
  return out.join('\n') + '\n';
}

// ───────────────────────── series and movie details ─────────────────────────
// Merges episodes from every server: a server missing episodes is filled in by another.
export async function mergedSeries(itemId) {
  const item = itemById(itemId);
  if (!item || item.type !== 'series') return null;
  const list = ranked(itemId).slice(0, 4);
  const raws = await Promise.all(list.map(s => seriesRaw(s).catch(() => null)));
  const primary = raws.find(Boolean) || {};
  const map = new Map();
  for (const j of raws) if (j) for (const e of flatEpisodes(j)) { const k = `${e._season}:${e._num}`; if (!map.has(k)) map.set(k, e); }
  const eps = [...map.values()].sort((a, b) => a._season - b._season || a._num - b._num);
  db.exec('BEGIN'); for (const e of eps) vepIns.run(itemId, e._season, e._num); db.exec('COMMIT');
  for (const e of eps) e._vid = vepFind.get(itemId, e._season, e._num).vid;
  return { item, primary, eps };
}

export async function vodInfo(itemId) {
  const item = itemById(itemId);
  const src = item && ranked(itemId).find(s => s.type === 'vod');
  if (!src) return null;
  const j = await kvCache(`vinfo:${src.server_id}:${src.stream_id}`, 24 * 3600e3, () =>
    xt(serverById(src.server_id), { action: 'get_vod_info', vod_id: src.stream_id }, 10000).then(r => r.j).catch(() => ({})));
  const info = j.info && !Array.isArray(j.info) ? j.info : {};
  return {
    info: { ...info, name: info.name || item.title, movie_image: info.movie_image || item.poster || '' },
    movie_data: { ...(j.movie_data || {}), stream_id: itemId, name: item.title, added: String(item.added || 0),
      category_id: String(item.category_id ?? UNCAT), container_extension: src.ext || j.movie_data?.container_extension || 'mp4', custom_sid: '', direct_source: '' },
  };
}

const epgCache = lru(2000);
export async function epgProxy(action, itemId, limit) {
  const k = `${action}|${itemId}|${limit || ''}`, c = epgCache.get(k);
  if (c && c.exp > Date.now()) return c.v;
  const src = ranked(itemId).find(s => s.type === 'live');
  if (!src) return { epg_listings: [] };
  const params = { action, stream_id: src.stream_id }; if (limit) params.limit = limit;
  const v = await xt(serverById(src.server_id), params, 10000).then(r => r.j).catch(() => ({ epg_listings: [] }));
  epgCache.set(k, { v, exp: Date.now() + 5 * 60e3 });
  return v;
}

// ───────────────────────── routes ─────────────────────────
const RESERVED = new Set(['api', 'img', 'live', 'movie', 'series', 'play']);

export async function xtreamRoutes({ req, res, path: p, qp }) {
  if (p === '/player_api.php' || p === '/panel_api.php') {
    const user = checkUser(qp('username'), qp('password'));
    if (!user) { send(req, res, 200, { user_info: { auth: 0 } }); return true; }
    const action = qp('action'), cat = qp('category_id');
    switch (action) {
      case null: case '': case 'get_profile': send(req, res, 200, authInfo(user, req)); return true;
      case 'get_live_categories': sendCached(req, res, cached('cat:live', () => categoriesOf('live'))); return true;
      case 'get_vod_categories': sendCached(req, res, cached('cat:vod', () => categoriesOf('vod'))); return true;
      case 'get_series_categories': sendCached(req, res, cached('cat:series', () => categoriesOf('series'))); return true;
      case 'get_live_streams': sendCached(req, res, cached(`live:${cat || ''}`, () => streamsOf('live', cat))); return true;
      case 'get_vod_streams': sendCached(req, res, cached(`vod:${cat || ''}`, () => streamsOf('vod', cat))); return true;
      case 'get_series': sendCached(req, res, cached(`series:${cat || ''}`, () => streamsOf('series', cat))); return true;
      case 'get_vod_info': send(req, res, 200, (await vodInfo(+qp('vod_id'))) || { info: [], movie_data: {} }); return true;
      case 'get_series_info': {
        const d = await mergedSeries(+qp('series_id'));
        if (!d) { send(req, res, 200, { seasons: [], info: {}, episodes: {} }); return true; }
        const episodes = {};
        for (const e of d.eps) (episodes[e._season] ||= []).push({ id: String(e._vid), episode_num: e._num, title: e.title || `Episode ${e._num}`,
          container_extension: e.container_extension || 'mp4', info: e.info && !Array.isArray(e.info) ? e.info : {}, custom_sid: '',
          added: e.added || '', season: e._season, direct_source: '' });
        const info = d.primary.info && !Array.isArray(d.primary.info) ? d.primary.info : {};
        send(req, res, 200, { seasons: d.primary.seasons || [], episodes,
          info: { ...info, name: d.item.title, cover: info.cover || d.item.poster || '', category_id: String(d.item.category_id ?? UNCAT) } });
        return true;
      }
      case 'get_short_epg': case 'get_simple_data_table':
        send(req, res, 200, await epgProxy(action, +qp('stream_id'), qp('limit'))); return true;
      default: send(req, res, 200, []); return true;
    }
  }

  if (p === '/get.php') {
    const user = checkUser(qp('username'), qp('password'));
    if (!user) { send(req, res, 401, 'unauthorized'); return true; }
    const c = cached(`m3u:${user.username}:${qp('output') || 'ts'}:${origin(req)}`, () => m3uPlaylist(user, req, qp('output')));
    sendCached(req, res, c, 'audio/x-mpegurl; charset=utf-8', { 'Content-Disposition': 'attachment; filename="playlist.m3u"' });
    return true;
  }

  if (p === '/xmltv.php') {
    const user = checkUser(qp('username'), qp('password'));
    if (!user) { send(req, res, 401, 'unauthorized'); return true; }
    // EPG comes from whichever server carries the most channels.
    const top = db.prepare("SELECT server_id FROM sources WHERE type='live' GROUP BY server_id ORDER BY count(*) DESC LIMIT 1").get();
    const s = top && serverById(top.server_id);
    if (!s) { send(req, res, 404, 'no epg'); return true; }
    redirect(res, `${base(s)}/xmltv.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password)}`);
    return true;
  }

  // ════════ playback URLs: 302 to the upstream server (zero bandwidth) ════════
  let m = p.match(/^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)(?:\.([a-z0-9]+))?$/i);
  if (!m) {
    const l = p.match(/^\/([^/]+)\/([^/]+)\/(\d+)(?:\.([a-z0-9]+))?$/i);
    if (l && !RESERVED.has(l[1])) m = [l[0], 'live', l[1], l[2], l[3], l[4]];
  }
  if (m) {
    const user = checkUser(decodeURIComponent(m[2]), decodeURIComponent(m[3]));
    if (!user) { send(req, res, 401, 'unauthorized'); return true; }
    const kind = m[1] === 'movie' ? 'vod' : m[1];
    const url = await resolve(kind, +m[4], user.username, req, +qp('src') || null, (m[5] || '').toLowerCase());
    if (url) redirect(res, url); else send(req, res, 404, 'not found');
    return true;
  }

  return false;
}
