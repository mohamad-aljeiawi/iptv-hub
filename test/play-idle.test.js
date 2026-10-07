// A viewer who disappears without saying so (closed tab, lost network) must not
// leave ffmpeg running: no heartbeat for PLAY_IDLE_MS ends the session.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdb } from './helpers.js';
import { HAVE_FFMPEG, makeMedia, fakeProvider } from './play-fixtures.js';

const env = tmpdb('play-idle', { PLAY_IDLE_MS: '1500' });
let db, server, provider, host, cookie;
const ffmpeg = { skip: !HAVE_FFMPEG && 'ffmpeg/ffprobe not installed' };
const LIVE = '/live/u/p/50.ts';

before(async () => {
  if (!HAVE_FFMPEG) return;
  const media = path.join(env.dir, 'media');
  fs.mkdirSync(media);
  makeMedia(media);
  ({ db } = await import('../src/db.js'));
  const { syncServer } = await import('../src/sync.js');
  ({ server } = await import('../src/index.js'));
  provider = fakeProvider(media, { vod: {}, live: { 50: ['Test Channel', 'live.ts'] } });
  db.prepare('INSERT INTO servers(id,name,url,username,password) VALUES(1,?,?,?,?)').run('fake', await provider.listen(), 'u', 'p');
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function startLive() {
  const src = db.prepare("SELECT item_id, id FROM sources WHERE type='live'").get();
  const r = await (await fetch(`${host}/api/play`, { method: 'POST', headers: { cookie },
    body: JSON.stringify({ kind: 'live', id: src.item_id, src: src.id }) })).json();
  await (await fetch(host + r.url, { headers: { cookie } })).text();   // wait until it plays
  return r;
}
const ping = id => fetch(`${host}/api/play/${id}/ping`, { method: 'POST', headers: { cookie } });

test('heartbeats keep a stream alive', ffmpeg, async () => {
  const s = await startLive();
  for (let i = 0; i < 8; i++) { await sleep(500); assert.equal((await ping(s.id)).status, 200); }
  assert.equal(provider.active(LIVE), 1);
  await fetch(`${host}/api/play/${s.id}/stop`, { method: 'POST', headers: { cookie } });
});

test('without heartbeats the stream, ffmpeg and the upstream connection go away', ffmpeg, async () => {
  const s = await startLive();
  assert.equal(provider.active(LIVE), 1);
  await sleep(4500);
  assert.equal((await ping(s.id)).status, 404, 'session ended');
  assert.equal(provider.active(LIVE), 0, 'upstream connection closed');
  assert.ok(!fs.existsSync(path.join(process.env.PLAY_DIR, s.id)), 'files removed');
});
