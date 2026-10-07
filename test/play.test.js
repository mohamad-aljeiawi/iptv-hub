// In-browser playback: the cheapest working path per stream, one upstream
// connection per session, the viewer and transcode limits, and cleanup.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdb } from './helpers.js';
import { HAVE_FFMPEG, makeMedia, probeFile, fakeProvider } from './play-fixtures.js';

const env = tmpdb('play', { PLAY_MAX_TRANSCODES: '1', PLAY_MAX_VIEWERS: '3' });
const media = path.join(env.dir, 'media');
let plan, ffmpegArgs, db, server, provider, host;
const ffmpeg = { skip: !HAVE_FFMPEG && 'ffmpeg/ffprobe not installed' };

before(async () => {
  ({ plan, ffmpegArgs } = await import('../src/play.js'));
  if (!HAVE_FFMPEG) return;
  fs.mkdirSync(media);
  makeMedia(media);
  ({ db } = await import('../src/db.js'));
  const { syncServer } = await import('../src/sync.js');
  ({ server } = await import('../src/index.js'));
  provider = fakeProvider(media, {
    vod: { 1: ['Direct Film (2001)', 'direct.mp4'], 2: ['Remux Film (2002)', 'remux.mkv'], 3: ['Ac3 Film (2003)', 'ac3.mkv'],
      4: ['Hevc Film (2004)', 'hevc.mkv'], 5: ['Long Film (2005)', 'long.mkv'], 6: ['Other Hevc (2006)', 'hevc.mkv'],
      7: ['Third Film (2007)', 'remux.mkv'], 8: ['Fourth Film (2008)', 'direct.mp4'] },
    live: { 50: ['Test Channel', 'live.ts'] },
  });
  const url = await provider.listen();
  db.prepare('INSERT INTO servers(id,name,url,username,password) VALUES(1,?,?,?,?)').run('fake', url, 'u', 'p');
  await syncServer(1);
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(ok => server.close(ok));
  if (provider) await provider.close();
  env.cleanup();
});

// ───── the decision, without ffmpeg ─────

const probe = (format, ...streams) => ({ format: { format_name: format, duration: '600.0' },
  streams: streams.map((s, index) => ({ index, ...s })) });
const h264 = { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' };
const aac = { codec_type: 'audio', codec_name: 'aac' };

test('browser-ready MP4 is relayed as it is', () => {
  assert.equal(plan(probe('mov,mp4,m4a,3gp,3g2,mj2', h264, aac), false).mode, 'direct');
});

test('a channel is never relayed raw, even with browser codecs', () => {
  assert.equal(plan(probe('mpegts', h264, aac), true).mode, 'remux');
});

test('MKV with H.264 and AAC is only remuxed', () => {
  assert.equal(plan(probe('matroska,webm', h264, aac), false).mode, 'remux');
});

test('AC3, EAC3 and DTS audio convert the audio only', () => {
  for (const codec_name of ['ac3', 'eac3', 'dts']) {
    assert.equal(plan(probe('matroska,webm', h264, { codec_type: 'audio', codec_name }), false).mode, 'audio', codec_name);
  }
});

test('HEVC, 10-bit H.264 and MPEG-2 video are re-encoded', () => {
  assert.equal(plan(probe('matroska,webm', { ...h264, codec_name: 'hevc' }, aac), false).mode, 'transcode');
  assert.equal(plan(probe('matroska,webm', { ...h264, pix_fmt: 'yuv420p10le' }, aac), false).mode, 'transcode');
  assert.equal(plan(probe('mpegts', { ...h264, codec_name: 'mpeg2video' }, aac), true).mode, 'transcode');
});

test('cover art is not mistaken for the video, and the default audio track wins', () => {
  const p = plan(probe('matroska,webm', { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }, h264,
    { codec_type: 'audio', codec_name: 'ac3' }, { codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } }), false);
  assert.deepEqual([p.video, p.audio, p.mode], [1, 3, 'remux']);
});

test('nothing playable gives no plan', () => {
  assert.equal(plan(probe('matroska,webm', { codec_type: 'subtitle', codec_name: 'subrip' }), false), null);
});

test('re-encoding is capped at 720p with the veryfast preset', () => {
  const a = ffmpegArgs({ mode: 'transcode', video: 0, audio: 1 }, 'http://x/1.mkv', '/tmp/s', { live: false }).join(' ');
  assert.match(a, /-c:v libx264 -preset veryfast/);
  assert.match(a, /scale=-2:'min\(720,ih\)'/);
  assert.match(a, /-c:a aac/);
  const r = ffmpegArgs({ mode: 'remux', video: 0, audio: 1 }, 'http://x/1.mkv', '/tmp/s', { live: false }).join(' ');
  assert.match(r, /-c:v copy .*-c:a copy/);
});

// ───── the real thing, with ffmpeg ─────

const login = async () => (await fetch(`${host}/api/login`, { method: 'POST',
  body: JSON.stringify({ username: 'admin', password: 'test-admin-token' }) })).headers.get('set-cookie').split(';')[0];
const ids = (streamId, type = 'vod') => db.prepare('SELECT item_id, id FROM sources WHERE stream_id=? AND type=?').get(String(streamId), type);
async function start(cookie, streamId, kind = 'vod') {
  const s = ids(streamId, kind);
  const r = await fetch(`${host}/api/play`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ kind, id: s.item_id, src: s.id }) });
  const body = { status: r.status, ...(await r.json()) };
  if (body.id) started.push([cookie, body.id]);
  return body;
}
// Every session a test starts is stopped afterwards, even when the test fails.
const started = [];
afterEach(async () => { for (const [c, id] of started.splice(0)) await call(c, id, 'stop').catch(() => {}); });
const call = (cookie, id, what, body) => fetch(`${host}/api/play/${id}/${what}`, { method: 'POST', headers: { cookie }, body: JSON.stringify(body || {}) });
async function firstSegment(cookie, url) {
  const list = await (await fetch(host + url, { headers: { cookie } })).text();
  const seg = list.split('\n').find(l => l.endsWith('.ts'));
  assert.ok(seg, list);
  const file = path.join(env.dir, `seg-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(file, Buffer.from(await (await fetch(host + url.replace('index.m3u8', seg), { headers: { cookie } })).arrayBuffer()));
  return probeFile(file);
}
const codecs = streams => streams.map(s => `${s.codec_type}:${s.codec_name}`).sort().join(' ');
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

test('without a web login nothing plays', ffmpeg, async () => {
  const r = await fetch(`${host}/api/play`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
});

test('direct: byte ranges relayed, and a new request replaces the old connection', ffmpeg, async () => {
  const cookie = await login();
  const s = await start(cookie, 1);
  assert.equal(s.tier, 'direct');
  const a = await fetch(host + s.url, { headers: { cookie } });   // a long read, left open
  const reader = a.body.getReader();
  await reader.read();
  const b = await fetch(host + s.url, { headers: { cookie, range: 'bytes=100-199' } });
  assert.equal(b.status, 206);
  assert.equal((await b.arrayBuffer()).byteLength, 100);
  reader.cancel().catch(() => {});
  assert.equal(provider.peak('/movie/u/p/1.mp4'), 1, 'never two upstream connections at once');
  await call(cookie, s.id, 'stop');
});

test('remux: MKV with H.264 and AAC is copied into HLS', ffmpeg, async () => {
  const cookie = await login();
  const s = await start(cookie, 2);
  assert.deepEqual([s.tier, s.mode], ['remux', 'hls']);
  assert.equal(codecs(await firstSegment(cookie, s.url)), 'audio:aac video:h264');
  await call(cookie, s.id, 'stop');
});

test('audio: AC3 becomes AAC, the video is untouched', ffmpeg, async () => {
  const cookie = await login();
  const s = await start(cookie, 3);
  assert.equal(s.tier, 'audio');
  const st = await firstSegment(cookie, s.url);
  assert.equal(codecs(st), 'audio:aac video:h264');
  assert.equal(st.find(x => x.codec_type === 'video').height, 240, 'video copied at its own size');
  await call(cookie, s.id, 'stop');
});

test('transcode: 1080p HEVC becomes 720p H.264', ffmpeg, async () => {
  const cookie = await login();
  const s = await start(cookie, 4);
  assert.equal(s.tier, 'transcode');
  const st = await firstSegment(cookie, s.url);
  assert.equal(codecs(st), 'audio:aac video:h264');
  assert.equal(st.find(x => x.codec_type === 'video').height, 720);
  await call(cookie, s.id, 'stop');
});

test('live: a TS channel plays as HLS over a single connection', ffmpeg, async () => {
  const cookie = await login();
  const s = await start(cookie, 50, 'live');
  assert.deepEqual([s.tier, s.live], ['remux', true]);
  assert.equal(codecs(await firstSegment(cookie, s.url)), 'audio:aac video:h264');
  assert.equal(provider.active('/live/u/p/50.ts'), 1);
  await call(cookie, s.id, 'stop');
  assert.ok(await until(() => provider.active('/live/u/p/50.ts') === 0), 'stopping closes the upstream connection');
  assert.equal(provider.peak('/live/u/p/50.ts'), 1);
});

test('seeking restarts ffmpeg at the new time, still on one connection', ffmpeg, async () => {
  const cookie = await login();
  const s = await start(cookie, 5);
  await firstSegment(cookie, s.url);
  const r = await (await call(cookie, s.id, 'seek', { t: 25 })).json();
  assert.equal(r.start, 25);
  assert.notEqual(r.url, s.url);
  assert.equal((await fetch(host + s.url, { headers: { cookie } })).status, 404, 'the old stream is gone');
  await firstSegment(cookie, r.url);
  assert.equal(provider.peak('/movie/u/p/5.mkv'), 1);
  await call(cookie, s.id, 'stop');
});

test('stopping ends the session and removes its files', ffmpeg, async () => {
  const cookie = await login();
  const s = await start(cookie, 2);
  await firstSegment(cookie, s.url);
  await call(cookie, s.id, 'stop');
  assert.equal((await call(cookie, s.id, 'ping')).status, 404);
  assert.ok(!fs.existsSync(path.join(process.env.PLAY_DIR, s.id)));
});

test('one stream per browser: starting another ends the first', ffmpeg, async () => {
  const cookie = await login();
  const a = await start(cookie, 2);
  const b = await start(cookie, 7);
  assert.equal((await call(cookie, a.id, 'ping')).status, 404);
  assert.equal((await call(cookie, b.id, 'ping')).status, 200);
  await call(cookie, b.id, 'stop');
});

test('a viewer from another login cannot touch my stream', ffmpeg, async () => {
  const mine = await login(), theirs = await login();
  const s = await start(mine, 2);
  assert.equal((await fetch(host + s.url, { headers: { cookie: theirs } })).status, 404);
  assert.equal((await call(theirs, s.id, 'stop')).status, 404);
  await call(mine, s.id, 'stop');
});

test('limits: one full transcode here, three viewers, then "busy"', ffmpeg, async () => {
  const [a, b, c, d] = [await login(), await login(), await login(), await login()];
  const sa = await start(a, 4);
  assert.equal(sa.tier, 'transcode');
  const sb = await start(b, 6);
  assert.deepEqual([sb.status, sb.busy], [503, 'transcode'], 'second re-encode refused');
  const sb2 = await start(b, 2);
  assert.equal(sb2.status, 200, 'a cheap remux is still allowed');
  const sc = await start(c, 8);
  assert.equal(sc.status, 200);
  const sd = await start(d, 7);
  assert.deepEqual([sd.status, sd.busy], [503, 'viewers']);
  for (const [k, s] of [[a, sa], [b, sb2], [c, sc]]) await call(k, s.id, 'stop');
});
