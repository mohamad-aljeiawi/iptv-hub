// In-browser playback without relaying any video.
//
// The web interface is served over HTTPS and the providers speak plain HTTP, so a
// browser refuses to follow the 302 from inside it (mixed content). A plain-HTTP
// page has no such restriction. /watch/<token> is that page: it plays
// /w/<token>/<source>.<ext>, which answers with the same 302 players get, and the
// video goes straight from the provider to the browser.
//
// The token replaces the login on these HTTP pages: it is signed, names one item
// and one user, and expires after TTL, so no password or session cookie ever
// travels over plain HTTP.
//
// NOTE ON LANGUAGE: the page text below is user-facing Arabic UI copy, like
// public/index.html. Everything else is English.
import crypto from 'node:crypto';
import { db, kvGet, kvSet, itemById } from './db.js';
import { send, redirect, origin } from './http.js';
import { ranked, resolve, vepGet } from './resolve.js';

const TTL = 12 * 3600;   // seconds a watch link stays valid

// Kept in the database so links survive a restart.
let key = kvGet('watch_key');
if (!key) { key = crypto.randomBytes(32).toString('base64url'); kvSet('watch_key', key); }
const mac = s => crypto.createHmac('sha256', key).update(s).digest('base64url').slice(0, 22);

export function watchToken(kind, id, username, now = Date.now()) {
  const body = Buffer.from(`${kind}:${id}:${Math.floor(now / 1000) + TTL}:${username}`).toString('base64url');
  return `${body}.${mac(body)}`;
}

function userActive(username) {
  if (username === 'admin') return true;
  const r = db.prepare('SELECT enabled, exp_date FROM users WHERE username=?').get(username);
  return !!r && !!r.enabled && !(r.exp_date && r.exp_date * 1000 < Date.now());
}

export function readToken(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(mac(body)), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [kind, id, exp, ...rest] = Buffer.from(body, 'base64url').toString().split(':');
  const username = rest.join(':');
  if (!['live', 'vod', 'series'].includes(kind) || +exp * 1000 < Date.now() || !userActive(username)) return null;
  return { kind, id: +id, username };
}

// The item behind a token, with its sources in failover order.
function describe({ kind, id }) {
  if (kind === 'series') {
    const ve = vepGet.get(id), item = ve && itemById(ve.item_id);
    if (!item) return null;
    return { title: `${item.title} - S${ve.season} E${ve.num}`, live: false,
      sources: ranked(item.id).map(s => ({ id: s.id, name: s.server, ext: 'mp4' })) };
  }
  const item = itemById(id);
  if (!item || item.type !== kind) return null;
  return { title: item.title + (item.year && kind !== 'live' ? ` (${item.year})` : ''), live: kind === 'live',
    sources: ranked(item.id).filter(s => s.type === kind).map(s => ({ id: s.id, name: s.server, ext: kind === 'live' ? 'm3u8' : (s.ext || 'mp4') })) };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };

function page(token, d, startSrc) {
  const data = JSON.stringify({ token, live: d.live, sources: d.sources, start: Math.max(0, d.sources.findIndex(s => s.id === startSrc)) })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(d.title)}</title>
<style>
:root{--ink:#0F1D2E;--panel:#172A40;--line:#2A4566;--text:#E9EEF5;--muted:#8EA2BA;--signal:#FFB547;--live:#FF5A5F}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--text);font-family:system-ui,sans-serif;line-height:1.5}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:1.1rem;font-weight:500;margin:0 0 12px}
video{width:100%;aspect-ratio:16/9;background:#000;border-radius:6px;display:block}
#status{min-height:1.5em;color:var(--muted);font-size:.9rem;margin:10px 0}
#status.err{color:var(--live)}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer}
button[aria-current=true]{border-color:var(--signal);color:var(--signal)}
</style>
</head>
<body>
<main>
<h1>${esc(d.title)}</h1>
<video id="v" controls autoplay playsinline></video>
<p id="status"></p>
<div class="row" id="srcs"></div>
</main>
<script>
const D = ${data};
const v = document.getElementById('v'), st = document.getElementById('status'), box = document.getElementById('srcs');
let i = D.start, hls = null, timer, run = 0;
const say = (t, err) => { st.textContent = t; st.className = err ? 'err' : ''; };
const nativeHls = v.canPlayType('application/vnd.apple.mpegurl') !== '';
let lib = null;
const loadHls = () => lib ||= new Promise((ok, bad) => {
  const s = Object.assign(document.createElement('script'), { src: 'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js',
    integrity: 'sha384-cciJ0zi8d1uMKC2zJd7jvPY4HQt7W4ByUI/FlMkltvBi31aW61rcpVBhpmW8/NwX', crossOrigin: 'anonymous' });
  s.onload = () => ok(window.Hls); s.onerror = () => { lib = null; bad(); }; document.head.append(s);
});
function draw() {
  box.innerHTML = '';
  D.sources.forEach((s, j) => {
    const b = document.createElement('button');
    b.textContent = s.name; b.setAttribute('aria-current', j === i);
    b.onclick = () => { i = j; play(); };
    box.append(b);
  });
}
function stop() {
  clearTimeout(timer); run++;
  v.onplaying = v.onerror = null;
  if (hls) { hls.destroy(); hls = null; }
  v.removeAttribute('src'); v.load();
}
function next(reason) {
  if (i + 1 < D.sources.length) { i++; say(reason + '، جاري التبديل إلى ' + D.sources[i].name); setTimeout(play, 400); }
  else { stop(); say(reason + '. جرّب مشغلاً خارجياً مثل VLC.', true); }
}
async function play() {
  stop(); draw();
  const s = D.sources[i], url = '/w/' + D.token + '/' + s.id + '.' + s.ext, me = run;
  say('جاري التشغيل من ' + s.name);
  timer = setTimeout(() => next('المصدر لم يستجب خلال 12 ثانية'), 12000);
  const fail = () => next(D.live ? 'المتصفح لا يستطيع تشغيل هذا البث' : 'تعذر تشغيل الملف في المتصفح، غالباً لأن صيغته لا يدعمها المتصفح');
  v.onplaying = () => { clearTimeout(timer); say('يعمل من ' + s.name); };
  v.onerror = fail;
  if (D.live && !nativeHls) {
    const Hls = await loadHls().catch(() => null);
    if (me !== run) return;
    if (Hls && Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_, e) => { if (e.fatal) fail(); });
      hls.loadSource(url); hls.attachMedia(v);
      v.play().catch(() => {});
      return;
    }
  }
  v.src = url; v.play().catch(() => {});
}
if (!D.sources.length) say('لا توجد مصادر لهذا العنصر.', true); else play();
</script>
</body>
</html>`;
}

// The page shown for an invalid or expired link (user-facing Arabic copy:
// "This link has expired or is invalid. Open the item again from the site.").
const EXPIRED = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><body style="font-family:system-ui;background:#0F1D2E;color:#E9EEF5;padding:24px">'
  + '<p>انتهت صلاحية هذا الرابط أو أنه غير صالح. افتح العنصر من جديد من الموقع.</p></body></html>';

export async function watchRoutes({ req, res, path: p, qp }) {
  let m = p.match(/^\/watch\/([\w.-]+)$/);
  if (m) {
    // This page must load over plain HTTP, or the browser blocks the provider's
    // HTTP stream again. Send an HTTPS visit back down.
    if (/^https/i.test(req.headers['x-forwarded-proto'] || '')) {
      redirect(res, origin(req).replace(/^https:/i, 'http:') + req.url);
      return true;
    }
    const t = readToken(m[1]);
    const d = t && describe(t);
    if (!d) { res.writeHead(403, PAGE_HEADERS); res.end(EXPIRED); return true; }
    res.writeHead(200, PAGE_HEADERS);
    res.end(page(m[1], d, +qp('src') || null));
    return true;
  }

  m = p.match(/^\/w\/([\w.-]+)\/(\d+)\.([a-z0-9]+)$/i);
  if (m) {
    const t = readToken(m[1]);
    if (!t) { send(req, res, 403, 'link expired'); return true; }
    const url = await resolve(t.kind, t.id, 'web:' + t.username, req, +m[2] || null, m[3].toLowerCase());
    if (url) redirect(res, url); else send(req, res, 404, 'not found');
    return true;
  }
  return false;
}
