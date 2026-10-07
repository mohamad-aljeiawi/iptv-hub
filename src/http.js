// HTTP helpers, the router, and the compressed response cache.
// This module knows nothing about the feature modules, which keeps the
// dependency graph free of cycles.
import zlib from 'node:zlib';
import { PUBLIC_URL } from './config.js';

const wantsGzip = req => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

export function send(req, res, code, body, extra = {}) {
  let buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...extra };
  if (buf.length > 1024 && wantsGzip(req)) { buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; }
  res.writeHead(code, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export function sendCached(req, res, c, type = 'application/json; charset=utf-8', extra = {}) {
  const gz = wantsGzip(req), b = gz ? c.gz : c.raw;
  res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Content-Length': b.length, ...(gz ? { 'Content-Encoding': 'gzip' } : {}), ...extra });
  res.end(req.method === 'HEAD' ? undefined : b);
}

export const redirect = (res, url) => { res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' }); res.end(); };

export const readBody = req => new Promise((ok, bad) => {
  let d = '';
  req.on('data', c => (d += c));
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { bad(e); } });
});

// The public URL as the player sees it. Relies on proxy headers, so nginx/caddy
// must forward Host and X-Forwarded-Proto.
export function origin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// A peer on loopback or a private network is our own proxy (nginx, Caddy, or the
// Docker gateway in front of the container), so its X-Forwarded-For is trusted.
const PRIVATE_PEER = /^(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|^(?:::1|f[cd][0-9a-f]{2}:)/i;

// The client address, for rate limiting. Proxies append the address they saw to
// X-Forwarded-For, so the LAST entry is the real client; the entries before it are
// whatever the client sent and can be forged. A request that did not come through
// a proxy is identified by its socket address alone.
export function clientIp(req) {
  const peer = req.socket?.remoteAddress || '?';
  const xff = req.headers['x-forwarded-for'];
  if (!xff || !PRIVATE_PEER.test(peer)) return peer;
  return xff.split(',').at(-1).trim() || peer;
}

// ───────────────────────── large response cache (raw + gzipped) ─────────────────────────
const listCache = new Map();
const clearHooks = [];

export const onClear = fn => clearHooks.push(fn);

export function cached(key, build) {
  let c = listCache.get(key);
  if (!c) {
    const v = build();
    const raw = Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));
    c = { raw, gz: zlib.gzipSync(raw, { level: raw.length > 4e6 ? 1 : 6 }) };
    listCache.set(key, c);
    if (listCache.size > 60) listCache.delete(listCache.keys().next().value);
  }
  return c;
}

export function clearCaches() {
  listCache.clear();
  for (const fn of clearHooks) { try { fn(); } catch { /* must never abort a sync */ } }
}

// ───────────────────────── small in-memory cache ─────────────────────────
export function lru(max = 1000) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); return v; },
    clear: () => m.clear(),
    get size() { return m.size; },
  };
}

// ───────────────────────── router ─────────────────────────
// Every sub-router takes a ctx and returns true once it has handled the request.
export function createHandler(routers) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ctx = { req, res, url, path: url.pathname, method: req.method, qp: k => url.searchParams.get(k) };
    try {
      for (const r of routers) if (await r(ctx)) return;
      send(req, res, 404, { error: 'not found' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(req, res, 500, { error: e.message });
    }
  };
}
