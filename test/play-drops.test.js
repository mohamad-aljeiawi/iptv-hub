// Providers that drop long connections at random (seen in the wild every 10 to 40
// seconds): the relay reconnects from the next byte, so the browser and ffmpeg
// never notice, and there is still only one upstream connection at a time.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdb } from './helpers.js';
import { HAVE_FFMPEG, makeMedia, fakeProvider } from './play-fixtures.js';

const env = tmpdb('play-drops');
const media = path.join(env.dir, 'media');
let db, server, provider, host, cookie;
const ffmpeg = { skip: !HAVE_FFMPEG && 'ffmpeg/ffprobe not installed' };

before(async () => {
  if (!HAVE_FFMPEG) return;
  fs.mkdirSync(media);
  makeMedia(media);
  ({ db } = await import('../src/db.js'));
  const { syncServer } = await import('../src/sync.js');
  ({ server } = await import('../src/index.js'));
  provider = fakeProvider(media, {
    vod: { 1: ['Direct Film (2001)', 'direct.mp4'], 2: ['Long Film (2002)', 'long.mkv'] },
    live: { 50: ['Test Channel', 'live.ts'] },
    dropEvery: 64 * 1024,
  });
  db.prepare('INSERT INTO servers(id,name,url,username,password) VALUES(1,?,?,?,?)').run('drops', await provider.listen(), 'u', 'p');
  await syncServer(1);
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
  cookie = (await fetch(`${host}/api/login`, { method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'test-admin-token' }) })).headers.get('set-cookie').split(';')[0];
});
after(async () => {
  if (server) await new Promise(ok => server.close(ok));
  if (provider) await provider.close();
  env.cleanup();
});

const start = async (streamId, kind = 'vod') => {
  const src = db.prepare('SELECT item_id, id FROM sources WHERE stream_id=? AND type=?').get(String(streamId), kind);
  return (await fetch(`${host}/api/play`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ kind, id: src.item_id, src: src.id }) })).json();
};
const stop = id => fetch(`${host}/api/play/${id}/stop`, { method: 'POST', headers: { cookie } });
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };

test('a direct file arrives complete and byte-identical through many drops', ffmpeg, async () => {
  const s = await start(1);
  assert.equal(s.tier, 'direct');
  const got = Buffer.from(await (await fetch(host + s.url, { headers: { cookie } })).arrayBuffer());
  const want = fs.readFileSync(path.join(media, 'direct.mp4'));
  assert.ok(want.length > 3 * 64 * 1024, 'the file is longer than one drop interval');
  assert.equal(got.length, want.length);
  assert.ok(got.equals(want), 'identical bytes');
  assert.equal(provider.peak('/movie/u/p/1.mp4'), 1);
  await stop(s.id);
});

test('ffmpeg converts a whole film although the provider keeps dropping', ffmpeg, async () => {
  const s = await start(2);
  const done = await until(async () => /#EXT-X-ENDLIST/.test(await (await fetch(host + s.url, { headers: { cookie } })).text()), 60000);
  assert.ok(done, 'the playlist reaches its end');
  const list = await (await fetch(host + s.url, { headers: { cookie } })).text();
  const total = list.split('\n').filter(l => l.startsWith('#EXTINF')).reduce((t, l) => t + parseFloat(l.slice(8)), 0);
  assert.ok(total > 38, `all 40 seconds converted (got ${total.toFixed(1)})`);
  assert.equal(provider.peak('/movie/u/p/2.mkv'), 1);
  await stop(s.id);
});

test('a live channel keeps going across drops', ffmpeg, async () => {
  const s = await start(50, 'live');
  const seq = async () => +(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(await (await fetch(host + s.url, { headers: { cookie } })).text())?.[1] ?? -1);
  await until(async () => (await seq()) >= 0, 20000);
  const first = await seq();
  const moved = await until(async () => (await seq()) >= first + 3, 30000);
  assert.ok(moved, 'new segments keep coming');
  assert.equal(provider.peak('/live/u/p/50.ts'), 1);
  await stop(s.id);
});
