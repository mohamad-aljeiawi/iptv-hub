// Web UI routes, static assets, and the admin JSON API.
//
// NOTE ON LANGUAGE: the error strings returned here are user-facing copy rendered
// by the Arabic interface in public/index.html, so they stay in Arabic on purpose.
// Everything else in this repository is English (see CLAUDE.md).
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { db, itemById, checkUser, session, newSession, kvDel, cleanupOrphans } from './db.js';
import { PUBLIC_DIR, UA } from './config.js';
import { send, readBody, origin, clearCaches, lru } from './http.js';
import { xt, scheduleSync, down, syncing } from './sync.js';
import { ranked } from './resolve.js';
import { search, COLS } from './search.js';
import { mergedSeries } from './xtream.js';

const publicServer = s => ({ id: s.id, name: s.name, host: new URL(s.url).host, status: s.status, exp_date: s.exp_date,
  max_conn: s.max_conn, latency: s.latency, last_sync: s.last_sync, error: s.error, down: down.has(s.id), syncing: syncing.has(s.id),
  items: db.prepare('SELECT count(*) c FROM sources WHERE server_id=?').get(s.id).c });

const imgCache = lru(400);

// Brute-force protection for login: 5 failed attempts per minute per IP.
// nginx also applies limit_req; this is a second layer that works behind any
// proxy (Caddy, for instance, has no built-in rate limiting).
const LOGIN_MAX = 5, LOGIN_WINDOW = 60e3;
const attempts = new Map();
function loginBlocked(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW);
  attempts.set(ip, a);
  if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
  return { blocked: a.length >= LOGIN_MAX, fail: () => a.push(now), pass: () => attempts.delete(ip) };
}

export async function uiRoutes({ req, res, path: p }) {
  if (p === '/' || p === '/index.html') {
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }
  const m = p.match(/^\/img\/(\d+)$/);
  if (m) {
    const it = db.prepare('SELECT poster FROM items WHERE id=?').get(+m[1]);
    if (!it?.poster) { res.writeHead(404).end(); return true; }
    let img = imgCache.get(it.poster);
    if (!img) {
      const r = await fetch(it.poster, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r?.ok) { res.writeHead(404).end(); return true; }
      img = imgCache.set(it.poster, { type: r.headers.get('content-type') || 'image/jpeg', buf: Buffer.from(await r.arrayBuffer()) });
    }
    res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=604800, immutable' });
    res.end(img.buf);
    return true;
  }
  return false;
}

export async function apiRoutes(ctx) {
  const { req, res, path: p, qp, method } = ctx;
  if (!p.startsWith('/api/')) return false;
  let m;

  if (p === '/api/login' && method === 'POST') {
    const gate = loginBlocked(req);
    if (gate.blocked) return send(req, res, 429, { error: 'محاولات كثيرة، انتظر دقيقة ثم أعد المحاولة' }), true;
    const b = await readBody(req);
    const user = checkUser(String(b.username || '').trim(), String(b.password || ''));
    if (!user) { gate.fail(); return send(req, res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' }), true; }
    gate.pass();
    const sid = newSession(user);
    const secure = origin(req).startsWith('https') ? '; Secure' : '';
    send(req, res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}` });
    return true;
  }

  const sess = session(req);
  if (!sess) return send(req, res, 401, { error: 'سجّل الدخول أولاً' }), true;

  if (p === '/api/logout') return send(req, res, 200, (kvDel('sess:' + sess.sid), { ok: true }), { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }), true;
  if (p === '/api/me') return send(req, res, 200, { username: sess.username, password: sess.password, admin: sess.admin, origin: origin(req) }), true;

  if (p === '/api/search') {
    const t0 = performance.now();
    const r = search(qp('q') || '', qp('type') || '', Math.min(+qp('limit') || 60, 200));
    return send(req, res, 200, { ...r, ms: +(performance.now() - t0).toFixed(1) }), true;
  }

  if (p === '/api/latest') {
    const rows = db.prepare(`SELECT ${COLS} FROM items i WHERE i.type=? ORDER BY i.added DESC LIMIT ?`)
      .all(qp('type') || 'vod', Math.min(+qp('limit') || 30, 100));
    return send(req, res, 200, rows.map(r => ({ id: r.id, type: r.type, title: r.title, year: r.year, rating: r.rating,
      sources: r.n_src, img: r.has_img ? `/img/${r.id}` : null }))), true;
  }

  if (p === '/api/stats') {
    const c = Object.fromEntries(db.prepare('SELECT type, count(*) n FROM items GROUP BY type').all().map(r => [r.type, r.n]));
    const servers = db.prepare('SELECT * FROM servers').all().map(publicServer);
    return send(req, res, 200, { items: c, sources: db.prepare('SELECT count(*) n FROM sources').get().n,
      servers: sess.admin ? servers : servers.map(s => ({ down: s.down, error: !!s.error, latency: s.latency, syncing: s.syncing, last_sync: s.last_sync })) }), true;
  }

  if ((m = p.match(/^\/api\/item\/(\d+)$/))) {
    const item = itemById(+m[1]);
    if (!item) return send(req, res, 404, { error: 'غير موجود' }), true;
    const sources = ranked(item.id).map(s => ({ id: s.id, server: s.server, quality: s.quality, ext: s.ext, down: down.has(s.server_id) || !!s.error }));
    return send(req, res, 200, { id: item.id, type: item.type, title: item.title, year: item.year, rating: item.rating,
      img: item.poster ? `/img/${item.id}` : null, sources }), true;
  }

  if ((m = p.match(/^\/api\/series\/(\d+)$/))) {
    const d = await mergedSeries(+m[1]);
    if (!d) return send(req, res, 404, { error: 'غير موجود' }), true;
    const seasons = new Map();
    for (const e of d.eps) {
      if (!seasons.has(e._season)) seasons.set(e._season, []);
      seasons.get(e._season).push({ vid: e._vid, num: e._num, title: e.title || '', plot: e.info?.plot || '', duration: e.info?.duration || '' });
    }
    return send(req, res, 200, { plot: d.primary.info?.plot || '', seasons: [...seasons].map(([season, episodes]) => ({ season, episodes })) }), true;
  }

  // ── admin only from here on ──
  if (!sess.admin) return send(req, res, 403, { error: 'هذه العملية للأدمن فقط' }), true;

  if (p === '/api/servers' && method === 'POST') {
    const b = await readBody(req);
    if (!b.url || !b.username || !b.password) return send(req, res, 400, { error: 'الرابط واسم المستخدم وكلمة المرور مطلوبة' }), true;
    const url = /^https?:\/\//.test(b.url.trim()) ? b.url.trim() : 'http://' + b.url.trim();
    try { new URL(url); } catch { return send(req, res, 400, { error: 'رابط السيرفر غير صالح' }), true; }
    try {
      const { j } = await xt({ url, username: b.username, password: b.password }, {}, 15000);
      if (!j.user_info || j.user_info.auth === 0) return send(req, res, 400, { error: 'بيانات الدخول مرفوضة من السيرفر' }), true;
    } catch (e) { return send(req, res, 400, { error: 'تعذر الاتصال بالسيرفر: ' + e.message }), true; }
    const id = Number(db.prepare('INSERT INTO servers(name,url,username,password) VALUES(?,?,?,?)')
      .run(b.name || new URL(url).host, url, b.username, b.password).lastInsertRowid);
    scheduleSync(id);
    return send(req, res, 201, { id }), true;
  }

  if ((m = p.match(/^\/api\/servers\/(\d+)\/sync$/)) && method === 'POST') {
    scheduleSync(+m[1]);
    return send(req, res, 202, { ok: true }), true;
  }

  if ((m = p.match(/^\/api\/servers\/(\d+)$/)) && method === 'DELETE') {
    db.exec('BEGIN');
    db.prepare('DELETE FROM sources WHERE server_id=?').run(+m[1]);
    db.prepare('DELETE FROM servers WHERE id=?').run(+m[1]);
    cleanupOrphans();
    db.exec('COMMIT');
    clearCaches();
    return send(req, res, 200, { ok: true }), true;
  }

  if (p === '/api/users' && method === 'GET')
    return send(req, res, 200, db.prepare('SELECT id, username, password, max_conn, exp_date, enabled FROM users ORDER BY id').all()), true;

  if (p === '/api/users' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim(), password = String(b.password || '').trim();
    if (!/^[\w.@-]{3,32}$/.test(username) || username === 'admin')
      return send(req, res, 400, { error: 'اسم المستخدم: من 3 إلى 32 حرفاً إنجليزياً أو رقماً، ولا يكون admin' }), true;
    if (!/^[\w.@!#$%-]{4,64}$/.test(password))
      return send(req, res, 400, { error: 'كلمة المرور: 4 أحرف على الأقل، بدون مسافات أو / أو ?' }), true;
    const exp = +b.days > 0 ? Math.floor(Date.now() / 1000) + Math.round(+b.days * 86400) : null;
    try {
      db.prepare('INSERT INTO users(username,password,max_conn,exp_date,created) VALUES(?,?,?,?,?)')
        .run(username, password, Math.max(1, +b.max_conn || 1), exp, Date.now());
    } catch { return send(req, res, 400, { error: 'اسم المستخدم موجود مسبقاً' }), true; }
    return send(req, res, 201, { ok: true }), true;
  }

  if ((m = p.match(/^\/api\/users\/(\d+)$/)) && method === 'DELETE') {
    db.prepare('DELETE FROM users WHERE id=?').run(+m[1]);
    return send(req, res, 200, { ok: true }), true;
  }

  return send(req, res, 404, { error: 'not found' }), true;
}
