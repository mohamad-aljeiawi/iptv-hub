// Source selection, automatic failover, and building the upstream URL.
// Video never passes through this server: the result is only used for a 302.
import { db, serverById, base } from './db.js';
import { down, episodesOf } from './sync.js';

const srcStmt = db.prepare(`SELECT s.*, v.name AS server, v.latency, v.error FROM sources s JOIN servers v ON v.id=s.server_id
  WHERE s.item_id=? ORDER BY (v.error IS NOT NULL), COALESCE(v.latency, 99999)`);

// Sources ordered: healthy before down, then fastest to respond.
export const ranked = itemId => srcStmt.all(itemId).sort((a, b) => down.has(a.server_id) - down.has(b.server_id));

// Remembers the last source handed to each user. If the player asks for the start
// of the same stream again within 2-20 seconds, that source failed, so move to the
// next one automatically.
const picks = new Map();

export function choose(who, key, list, req) {
  const k = who + '|' + key, now = Date.now(), prev = picks.get(k);
  const range = req.headers.range;
  const fresh = !range || /^bytes=0-/.test(range);   // start of the stream, not a seek inside a movie
  let idx = 0;
  if (prev) {
    const dt = now - prev.t;
    if (fresh && prev.fresh && dt > 2000 && dt < 20000) idx = prev.idx + 1;
    else if (dt <= 2000 || !fresh || (key[0] !== 'l' && dt < 6 * 3600e3)) idx = prev.idx;
  }
  picks.set(k, { idx, t: now, fresh });
  if (picks.size > 20000) picks.delete(picks.keys().next().value);
  return list[idx % list.length];
}

export function upstream(src, kind, ext, ep) {
  const s = serverById(src.server_id);
  const U = encodeURIComponent(s.username), P = encodeURIComponent(s.password), b = base(s);
  if (kind === 'live') return `${b}/live/${U}/${P}/${src.stream_id}.${ext === 'm3u8' ? 'm3u8' : 'ts'}`;
  if (kind === 'vod') return `${b}/movie/${U}/${P}/${src.stream_id}.${src.ext || 'mp4'}`;
  return `${b}/series/${U}/${P}/${ep.id}.${ep.ext || 'mp4'}`;
}

export const vepGet = db.prepare('SELECT * FROM vepisodes WHERE vid=?');
export const vepIns = db.prepare('INSERT OR IGNORE INTO vepisodes(item_id,season,num) VALUES(?,?,?)');
export const vepFind = db.prepare('SELECT vid FROM vepisodes WHERE item_id=? AND season=? AND num=?');

export async function resolve(kind, id, who, req, forced, ext) {
  if (kind === 'series') {
    const ve = vepGet.get(id); if (!ve) return null;
    const list = ranked(ve.item_id); if (!list.length) return null;
    let start = forced ? list.findIndex(s => s.id === forced) : list.indexOf(choose(who, 'e' + id, list, req));
    if (start < 0) start = 0;
    for (let i = 0; i < list.length; i++) {           // if this server lacks the episode, try the next
      const src = list[(start + i) % list.length];
      const ep = (await episodesOf(src).catch(() => null))?.get(`${ve.season}:${ve.num}`);
      if (ep) return upstream(src, 'series', null, ep);
    }
    return null;
  }
  const list = ranked(id).filter(s => s.type === kind);
  if (!list.length) return null;
  const src = forced ? (list.find(s => s.id === forced) || list[0]) : choose(who, kind[0] + id, list, req);
  return upstream(src, kind, ext);
}
