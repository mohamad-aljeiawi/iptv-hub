// Without ffmpeg (running outside the Docker image), the web player must say so
// plainly instead of blaming the provider, and everything else keeps working.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdb } from './helpers.js';

const env = tmpdb('play-missing', { FFPROBE: 'ffprobe-that-does-not-exist', FFMPEG: 'ffmpeg-that-does-not-exist' });
let db, server, mock, host, cookie;

before(async () => {
  ({ db } = await import('../src/db.js'));
  const { syncServer } = await import('../src/sync.js');
  ({ server } = await import('../src/index.js'));
  const { mockXtream } = await import('./mock-xtream.js');
  mock = mockXtream({ name: 'one' });
  db.prepare('INSERT INTO servers(id,name,url,username,password) VALUES(1,?,?,?,?)').run('one', await mock.listen(), 'u', 'p');
  await syncServer(1);
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
  cookie = (await fetch(`${host}/api/login`, { method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'test-admin-token' }) })).headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise(ok => server.close(ok));
  await mock.close();
  env.cleanup();
});

test('in-browser playback reports itself unavailable, not a broken source', async () => {
  const src = db.prepare("SELECT item_id, id FROM sources WHERE type='vod'").get();
  const r = await fetch(`${host}/api/play`, { method: 'POST', headers: { cookie },
    body: JSON.stringify({ kind: 'vod', id: src.item_id, src: src.id }) });
  assert.equal(r.status, 501);
  assert.equal((await r.json()).busy, 'unavailable', 'the player shows the external-player buttons');
});

test('players are unaffected and still get their 302', async () => {
  const id = db.prepare("SELECT item_id FROM sources WHERE type='vod'").get().item_id;
  const r = await fetch(`${host}/movie/admin/test-admin-token/${id}.mp4`, { redirect: 'manual' });
  assert.equal(r.status, 302);
});
