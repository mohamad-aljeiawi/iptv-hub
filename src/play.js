// In-browser playback through this server, with ffmpeg where it is needed.
//
// Players (TiviMate, Smarters, VLC) get a 302 to the provider and use none of this
// server's bandwidth; nothing here changes that. A browser cannot play most IPTV
// streams as they are (MPEG-TS channels, MKV, HEVC, AC3), and an HTTPS page may not
// load the providers' plain-HTTP URLs at all. So the web player streams through
// here, by the cheapest path that works for the stream in hand:
//
//   direct     browser-ready MP4 (H.264 + AAC/MP3): relayed byte for byte
//   remux      H.264 + AAC/MP3 in another container (MKV, TS): copied into HLS
//   audio      H.264 with AC3/EAC3/DTS/...: video copied, audio converted to AAC
//   transcode  any other video (HEVC, 10-bit, MPEG-2...): re-encoded to H.264 <= 720p
//
// Each session holds exactly one upstream connection at a time, which also keeps
// single-connection provider accounts working. A session ends, and its ffmpeg is
// killed, when the viewer stops, closes the player, or stops sending heartbeats.
//
// NOTE ON LANGUAGE: error strings returned to the web player are user-facing
// Arabic copy, like those in api.js. Everything else is English.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { session as webSession, kvCache } from './db.js';
import { UA, PLAY_MAX_VIEWERS, PLAY_MAX_TRANSCODES, PLAY_MAX_HEIGHT, PLAY_DIR, FFMPEG, FFPROBE } from './config.js';
import { send, readBody } from './http.js';
import { resolve } from './resolve.js';

// No heartbeat or request for this long ends a session. PLAY_IDLE_MS exists for
// the tests; there is no reason to change it in production.
const IDLE_MS = +process.env.PLAY_IDLE_MS || 30e3;
const SEGMENT = 4;           // HLS segment length, seconds

// ───────────────────────── deciding the path ─────────────────────────

const OK_AUDIO = new Set(['aac', 'mp3']);
const okVideo = v => v.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(v.pix_fmt);
// Subtitles that are text and can become WebVTT. Image subtitles (PGS, DVD) would
// have to be burned into the picture, which means a full re-encode; not offered.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const MAX_SUBS = 8;
const lang = s => (s.tags?.language && s.tags.language !== 'und' ? s.tags.language : null);
const track = s => ({ index: s.index, codec: s.codec_name, lang: lang(s), title: s.tags?.title || null, channels: s.channels || null });

// From ffprobe's JSON to a playback plan, for the chosen audio track (or the
// file's default). Pure, so the tiers are testable.
export function plan(probe, live, audioIndex = null) {
  const streams = probe?.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = streams.filter(s => s.codec_type === 'audio');
  const def = audios.find(s => s.disposition?.default) || audios[0];
  const a = audios.find(s => s.index === audioIndex) || def;
  if (!v && !a) return null;
  const subs = live ? [] : streams.filter(s => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name)).slice(0, MAX_SUBS);
  const videoOk = !v || okVideo(v), audioOk = !a || OK_AUDIO.has(a.codec_name);
  const mp4 = /(^|,)(mp4|mov)(,|$)/.test(probe.format?.format_name || '');
  // The file can only go to the browser as it is when it plays the file's default
  // audio and has no subtitles to show; anything else needs HLS.
  const mode = !live && mp4 && videoOk && audioOk && a === def && !subs.length ? 'direct'
    : videoOk && audioOk ? 'remux'
    : videoOk ? 'audio'
    : 'transcode';
  const duration = live ? null : (+probe.format?.duration || null);
  return { mode, video: v ? v.index : null, audio: a ? a.index : null, duration,
    audios: audios.map(track), subs: subs.map(track) };
}

export function ffmpegArgs(p, url, dir, { live, start = 0 }) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-user_agent', UA,
    '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000'];
  // Films are read at twice real time after a quick start, so a paused or
  // abandoned film does not pull the whole file, and playback at up to 1.5x never
  // catches up with the conversion. Live input is real time already.
  if (!live) a.push('-readrate', '2', '-readrate_initial_burst', '20');
  else a.push('-reconnect_streamed', '1');
  if (start > 0) a.push('-ss', String(start));
  a.push('-i', url);
  if (p.video != null) a.push('-map', `0:${p.video}`);
  if (p.audio != null) a.push('-map', `0:${p.audio}`);
  a.push('-sn', '-dn', '-max_muxing_queue_size', '1024');
  if (p.video != null) {
    if (p.mode === 'transcode') {
      a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '3500k', '-bufsize', '7000k',
        '-vf', `scale=-2:'min(${PLAY_MAX_HEIGHT},ih)'`, '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT})`, '-threads', '2');
    } else a.push('-c:v', 'copy');
  }
  if (p.audio != null) {
    if (p.mode === 'remux') a.push('-c:a', 'copy');
    else a.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  a.push('-f', 'hls', '-hls_time', String(SEGMENT), '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'));
  if (live) a.push('-hls_list_size', '8', '-hls_flags', 'delete_segments+independent_segments');
  else a.push('-hls_playlist_type', 'event', '-hls_list_size', '0');
  a.push(path.join(dir, 'index.m3u8'));
  // Text subtitles come out of the same process, read from the same single
  // connection: one WebVTT file per track, written as the film is read.
  (p.subs || []).forEach((sub, i) => a.push('-map', `0:${sub.index}`, '-c:s', 'webvtt', '-f', 'webvtt', path.join(dir, `sub${i}.vtt`)));
  return a;
}

function ffprobe(url) {
  return new Promise((ok, bad) => execFile(FFPROBE, ['-v', 'error', '-user_agent', UA, '-rw_timeout', '15000000',
    '-probesize', '2000000', '-analyzeduration', '3000000',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,pix_fmt,channels:stream_tags=language,title:stream_disposition=default,attached_pic',
    '-of', 'json', url], { timeout: 30000, maxBuffer: 1 << 20, windowsHide: true },
  (err, out) => { if (err) return bad(err); try { ok(JSON.parse(out)); } catch (e) { bad(e); } }));
}

// Probe results are cached: a week for films and episodes (files do not change),
// ten minutes for channels. A replay or a seek then costs no extra connection.
const liveProbes = new Map();
async function probeOnce(key, url, live) {
  if (!live) return kvCache(`probe2:${key}`, 7 * 86400e3, () => ffprobe(url));
  const hit = liveProbes.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await ffprobe(url);
  liveProbes.set(key, { v, exp: Date.now() + 10 * 60e3 });
  if (liveProbes.size > 2000) liveProbes.delete(liveProbes.keys().next().value);
  return v;
}

// ───────────────────────── sessions ─────────────────────────

const sessions = new Map();
export const activeSessions = () => sessions.size;

const transcodes = () => [...sessions.values()].filter(s => s.plan?.mode === 'transcode').length;

function killProc(proc) {
  // No pid means it never started (spawn failed), and then 'exit' never fires.
  if (!proc || proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise(ok => {
    proc.once('exit', ok);
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
  });
}

async function stop(s) {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  await killProc(s.proc);
  await dropUpstream(s);
  await fsp.rm(path.join(PLAY_DIR, s.id), { recursive: true, force: true }).catch(() => {});
}

// Replace the running ffmpeg (if any) with one that starts at `start` seconds.
// The old process has exited, and so released its upstream connection, before the
// new one connects.
async function startFfmpeg(s, start) {
  const old = s.proc;
  s.proc = null;
  await killProc(old);
  const gen = ++s.gen;
  if (gen > 1) await fsp.rm(path.join(PLAY_DIR, s.id, String(gen - 1)), { recursive: true, force: true }).catch(() => {});
  const dir = path.join(PLAY_DIR, s.id, String(gen));
  await fsp.mkdir(dir, { recursive: true });
  const proc = spawn(FFMPEG, ffmpegArgs(s.plan, await inputUrl(s), dir, { live: s.live, start }), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let tail = '';
  proc.stderr.on('data', d => { tail = (tail + d).slice(-2000); });
  proc.on('error', e => { tail += String(e.message); });
  proc.on('exit', code => {
    if (s.proc === proc && code !== 0 && code !== null) { s.error = tail.trim() || `ffmpeg exited with ${code}`; console.error(`play ${s.id}: ${s.error}`); }
  });
  s.proc = proc;
  s.start = start;
  s.error = null;
  return gen;
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.seen > IDLE_MS) stop(s);
}, Math.min(5000, IDLE_MS / 2));
reaper.unref();

// Leave no ffmpeg behind when the app itself stops.
process.on('exit', () => { for (const s of sessions.values()) s.proc?.kill('SIGKILL'); });

// Clear session folders left by a previous run. Only names this module creates
// are touched, in case PLAY_DIR points somewhere shared.
fs.mkdirSync(PLAY_DIR, { recursive: true });
for (const d of fs.readdirSync(PLAY_DIR)) if (/^[\w-]{16}$/.test(d)) fs.rmSync(path.join(PLAY_DIR, d), { recursive: true, force: true });

// ───────────────────────── the one upstream connection ─────────────────────────
//
// Everything a session reads from the provider goes through relayUpstream(): the
// browser's requests in direct mode, and ffprobe's and ffmpeg's through a private
// loopback server. Neither ffmpeg nor a browser ever connects to the provider
// itself. That matters because both open a second connection to seek before
// closing the first, and a provider that allows one connection per account would
// refuse it. Here the old upstream connection is always closed before the new one
// is opened.

// One plain HTTP(S) request with no connection pool, so the socket closes with the
// response. Redirects are followed by hand (Xtream panels often bounce to a
// load-balanced host).
function openUpstream(url, headers, hops = 0) {
  return new Promise((ok, bad) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers, agent: false, timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume(); req.destroy();
        return openUpstream(new URL(res.headers.location, url).href, headers, hops + 1).then(ok, bad);
      }
      ok({ req, res });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
  });
}

// Close the session's upstream connection and wait until its socket is gone.
function dropUpstream(s) {
  const r = s.upstream;
  s.upstream = null;
  const sock = r?.socket;
  if (!r) return Promise.resolve();
  if (!sock || sock.destroyed) { r.destroy(); return Promise.resolve(); }
  return new Promise(ok => { sock.once('close', ok); r.destroy(); setTimeout(ok, 1000).unref(); });
}

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified'];

async function relayUpstream(req, res, s) {
  // Opening is serialized per session and the newest request wins: it closes the
  // previous connection first, and a request overtaken while waiting gives up.
  const turn = s.turn = (s.turn || 0) + 1;
  const headers = { 'User-Agent': UA };
  if (req.headers.range) headers.Range = req.headers.range;
  const up = await (s.opening = (s.opening || Promise.resolve()).then(async () => {
    await dropUpstream(s);
    if (turn !== s.turn || res.destroyed || !sessions.has(s.id)) return null;
    try { const u = await openUpstream(s.url, headers); s.upstream = u.req; return u; } catch { return 'error'; }
  }));
  if (up === null) { res.destroy(); return; }
  if (up === 'error') { if (!res.headersSent) send(req, res, 502, 'upstream unreachable'); return; }
  res.on('close', () => { if (s.upstream === up.req) dropUpstream(s); else up.req.destroy(); });
  if (up.res.statusCode >= 400) { up.req.destroy(); send(req, res, up.res.statusCode === 416 ? 416 : 502, 'upstream error'); return; }
  const out = { 'Cache-Control': 'no-store' };
  for (const h of PASS) if (up.res.headers[h]) out[h] = up.res.headers[h];
  res.writeHead(up.res.statusCode, out);
  if (req.method === 'HEAD') { up.req.destroy(); res.end(); return; }
  up.res.on('close', () => { if (!res.writableEnded) res.destroy(); });   // replaced or cut off
  up.res.pipe(res);
}

// ffprobe and ffmpeg read from here: 127.0.0.1 only, on a port of its own, and a
// session's URL carries a secret that never leaves the server.
let input = null;
function inputBase() {
  return input ||= new Promise(ok => {
    const srv = http.createServer((req, res) => {
      const [, id, secret] = req.url.split('/');
      const s = sessions.get(id);
      if (!s || !secret || secret !== s.secret) { res.writeHead(404).end(); return; }
      relayUpstream(req, res, s).catch(() => res.destroy());
    });
    srv.listen(0, '127.0.0.1', () => { srv.unref(); ok(`http://127.0.0.1:${srv.address().port}`); });
  });
}
const inputUrl = async s => `${await inputBase()}/${s.id}/${s.secret}`;

// ───────────────────────── HTTP routes ─────────────────────────

async function waitFor(file, s, gen, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (s.gen !== gen || !sessions.has(s.id)) return false;
    try { await fsp.access(file); return true; } catch { /* not written yet */ }
    if (s.error || (s.proc && s.proc.exitCode !== null && s.proc.exitCode !== 0)) return false;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

const hlsUrl = s => `/play/${s.id}/${s.gen}/index.m3u8`;
const describe = s => ({ id: s.id, mode: s.plan.mode === 'direct' ? 'direct' : 'hls', tier: s.plan.mode, live: s.live,
  duration: s.plan.duration, start: s.start || 0, url: s.plan.mode === 'direct' ? `/play/${s.id}/direct` : hlsUrl(s),
  audio: s.plan.audio, audios: s.plan.audios,
  subs: s.plan.subs.map((t, i) => ({ ...t, url: `/play/${s.id}/${s.gen}/sub${i}.vtt` })) });

export async function playRoutes(ctx) {
  const { req, res, path: p, method } = ctx;
  if (!p.startsWith('/play/') && !p.startsWith('/api/play')) return false;
  const web = webSession(req);
  // User-facing (Arabic): "log in first".
  if (!web) { send(req, res, 401, { error: 'سجّل الدخول أولاً' }); return true; }
  let m;

  // Start watching: POST /api/play {kind, id, src, start?, audio?}
  if (p === '/api/play' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const kind = ['live', 'vod', 'series'].includes(b.kind) ? b.kind : null;
    if (!kind || !(+b.id > 0)) { send(req, res, 400, { error: 'bad request' }); return true; }
    // One stream per logged-in browser: starting a new one ends the previous.
    for (const s of [...sessions.values()]) if (s.owner === web.sid) await stop(s);
    // User-facing (Arabic): "the maximum number of browser viewers has been reached".
    if (sessions.size >= PLAY_MAX_VIEWERS) { send(req, res, 503, { busy: 'viewers', error: 'وصل عدد المشاهدين في المتصفح إلى الحد الأقصى الآن' }); return true; }

    const s = { id: crypto.randomBytes(12).toString('base64url'), secret: crypto.randomBytes(18).toString('base64url'),
      owner: web.sid, live: kind === 'live', gen: 0, seen: Date.now(), plan: null };
    sessions.set(s.id, s);   // holds a viewer slot while probing
    try {
      s.url = await resolve(kind, +b.id, 'web:' + web.username, { headers: {} }, +b.src || null, 'ts');
      // User-facing (Arabic): "not available".
      if (!s.url) { await stop(s); send(req, res, 404, { error: 'غير متوفر' }); return true; }
      let probe;
      try { probe = await probeOnce(`${kind}:${b.id}:${b.src || 0}`, await inputUrl(s), s.live); } catch (e) {
        await stop(s);
        // No ffprobe on this machine (running without the Docker image): say so, and
        // let the player offer the external-player buttons. User-facing (Arabic):
        // "playing in the browser is not available on this server".
        if (e.code === 'ENOENT') send(req, res, 501, { busy: 'unavailable', error: 'التشغيل داخل المتصفح غير متاح على هذا الخادم' });
        // User-facing (Arabic): "the source did not respond".
        else send(req, res, 502, { error: 'المصدر لم يستجب' });
        return true;
      }
      s.probe = probe;
      const pl = plan(probe, s.live, b.audio == null ? null : +b.audio);
      // User-facing (Arabic): "this stream has no playable video or audio".
      if (!pl) { await stop(s); send(req, res, 415, { error: 'لا يحتوي هذا المصدر على صوت أو صورة قابلة للتشغيل' }); return true; }
      if (pl.mode === 'transcode' && transcodes() >= PLAY_MAX_TRANSCODES) {
        await stop(s);
        // User-facing (Arabic): "the server is converting too many videos right now".
        send(req, res, 503, { busy: 'transcode', error: 'الخادم يحوّل عدداً كبيراً من الفيديوهات الآن' });
        return true;
      }
      s.plan = pl;
      if (!sessions.has(s.id)) { send(req, res, 410, { error: 'stopped' }); return true; }
      // Resuming a film starts the conversion at that second. A direct file seeks in
      // the browser instead.
      const start = s.live ? 0 : Math.max(0, Math.min(Math.floor(+b.start || 0), (pl.duration || Infinity) - 1));
      if (pl.mode !== 'direct') await startFfmpeg(s, start);
      send(req, res, 200, describe(s));
    } catch (e) {
      await stop(s);
      throw e;
    }
    return true;
  }

  if ((m = p.match(/^\/api\/play\/([\w-]+)\/(ping|stop|seek)$/)) && method === 'POST') {
    const s = sessions.get(m[1]);
    if (!s || s.owner !== web.sid) { send(req, res, 404, { error: 'gone' }); return true; }
    s.seen = Date.now();
    if (m[2] === 'ping') { send(req, res, 200, { ok: true, error: s.error ? 'stream failed' : null }); return true; }
    if (m[2] === 'stop') { await stop(s); send(req, res, 200, { ok: true }); return true; }
    // seek: restart ffmpeg at second t, optionally with another audio track. A
    // direct file only comes here to change audio, and becomes HLS for it.
    const b = await readBody(req).catch(() => ({}));
    if (!s.plan) { send(req, res, 409, { error: 'starting' }); return true; }
    const audio = b.audio == null ? s.plan.audio : +b.audio;
    if (audio !== s.plan.audio) {
      const next = plan(s.probe, s.live, audio);
      if (next.mode === 'direct') next.mode = 'remux';
      if (next.mode === 'transcode' && s.plan.mode !== 'transcode' && transcodes() >= PLAY_MAX_TRANSCODES) {
        // User-facing (Arabic): "the server is converting too many videos right now".
        send(req, res, 503, { busy: 'transcode', error: 'الخادم يحوّل عدداً كبيراً من الفيديوهات الآن' });
        return true;
      }
      s.plan = next;
    } else if (s.plan.mode === 'direct' || s.live) { send(req, res, 400, { error: 'not seekable here' }); return true; }
    const t = s.live ? 0 : Math.max(0, Math.min(+b.t || 0, (s.plan.duration || Infinity) - 1));
    await startFfmpeg(s, Math.floor(t));
    send(req, res, 200, describe(s));
    return true;
  }

  if ((m = p.match(/^\/play\/([\w-]+)\/(.+)$/))) {
    const s = sessions.get(m[1]);
    if (!s || s.owner !== web.sid) { send(req, res, 404, 'gone'); return true; }
    s.seen = Date.now();
    if (m[2] === 'direct') {
      if (s.plan?.mode !== 'direct') { send(req, res, 404, 'not found'); return true; }
      await relayUpstream(req, res, s);
      return true;
    }
    const f = m[2].match(/^(\d+)\/(index\.m3u8|seg\d{5}\.ts|sub\d\.vtt)$/);
    if (!f || +f[1] !== s.gen) { send(req, res, 404, 'not found'); return true; }
    const file = path.join(PLAY_DIR, s.id, f[1], f[2]);
    if (f[2] === 'index.m3u8') {
      if (!(await waitFor(file, s, +f[1]))) { send(req, res, 502, 'stream failed'); return true; }
      const body = await fsp.readFile(file).catch(() => null);
      if (!body) { send(req, res, 404, 'not found'); return true; }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    const st = await fsp.stat(file).catch(() => null);
    if (!st) { send(req, res, 404, 'not found'); return true; }
    // Subtitle files grow while the film is read; the player fetches them again.
    const type = f[2].endsWith('.vtt') ? 'text/vtt; charset=utf-8' : 'video/mp2t';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  }

  return false;
}
