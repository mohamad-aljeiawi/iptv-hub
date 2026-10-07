// 302 redirects: video never passes through this server, and a dead upstream is
// swapped out automatically.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdb, get } from './helpers.js';

const env = tmpdb('redirect');
let db, server, down, syncServer, mocks, urls, host;

before(async () => {
  ({ db } = await import('../src/db.js'));
  ({ down, syncServer } = await import('../src/sync.js'));
  ({ server } = await import('../src/index.js'));
  const { mockXtream } = await import('./mock-xtream.js');

  mocks = [mockXtream({ name: 'one' }), mockXtream({ name: 'two' })];
  urls = [];
  for (const [i, m] of mocks.entries()) {
    urls.push(await m.listen());
    db.prepare('INSERT INTO servers(id,name,url,username,password,latency) VALUES(?,?,?,?,?,?)').run(i + 1, m.name, urls[i], 'up' + i, 'pw' + i, (i + 1) * 10);
    await syncServer(i + 1);
  }
  // Syncing overwrites latency with the measured value, so pin it to keep the
  // source ordering deterministic in these tests.
  db.prepare('UPDATE servers SET latency=id*10').run();
  db.prepare('INSERT INTO users(id,username,password,max_conn,enabled,created) VALUES(1,?,?,2,1,?)').run('joe', 'secret', Date.now());
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(ok => server.close(ok));
  for (const m of mocks) await m.close();
  env.cleanup();
});

const liveId = () => db.prepare("SELECT id FROM items WHERE type='live' ORDER BY id LIMIT 1").get().id;

test('a channel request returns 302 to the upstream server instead of streaming', async () => {
  const r = await get(`${host}/live/joe/secret/${liveId()}.ts`);
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.ok(loc.startsWith(urls[0]), `redirects to the fastest server: ${loc}`);
  assert.match(loc, /\/live\/up0\/pw0\/\d+\.ts$/, 'uses the upstream credentials, not the local user');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('the m3u8 extension is preserved', async () => {
  const r = await get(`${host}/live/joe/secret/${liveId()}.m3u8`);
  assert.match(r.headers.get('location'), /\.m3u8$/);
});

test('a wrong password is rejected', async () => {
  const r = await get(`${host}/live/joe/wrong/${liveId()}.ts`);
  assert.equal(r.status, 401);
});

test('when the first server is down the second is used', async () => {
  down.add(1);
  const r = await get(`${host}/live/joe/secret/${liveId()}.ts`);
  down.delete(1);
  assert.ok(r.headers.get('location').startsWith(urls[1]), 'switched to the second server');
});

test('a specific source can be forced with ?src=', async () => {
  const srcs = db.prepare('SELECT id, server_id FROM sources WHERE item_id=?').all(liveId());
  const second = srcs.find(s => s.server_id === 2);
  const r = await get(`${host}/live/joe/secret/${liveId()}.ts?src=${second.id}`);
  assert.ok(r.headers.get('location').startsWith(urls[1]));
});

test('an unknown id returns 404', async () => {
  const r = await get(`${host}/live/joe/secret/999999.ts`);
  assert.equal(r.status, 404);
});

test('player_api returns account info and listings', async () => {
  const auth = await (await get(`${host}/player_api.php?username=joe&password=secret`)).json();
  assert.equal(auth.user_info.auth, 1);
  assert.equal(auth.user_info.username, 'joe');
  const live = await (await get(`${host}/player_api.php?username=joe&password=secret&action=get_live_streams`)).json();
  assert.ok(live.length >= 2);
  assert.ok(live.every(x => x.stream_type === 'live'));
});

test('bad credentials return auth=0 as players expect', async () => {
  const j = await (await get(`${host}/player_api.php?username=joe&password=nope`)).json();
  assert.equal(j.user_info.auth, 0);
});

test('the M3U playlist points at this server, not at the upstream', async () => {
  const r = await get(`${host}/get.php?username=joe&password=secret&type=m3u_plus`);
  const body = await r.text();
  assert.match(body, /^#EXTM3U/);
  assert.ok(body.includes(`${host}/live/joe/secret/`), 'links go through us so failover keeps working');
  assert.ok(!body.includes('up0'), 'upstream credentials never leak into the playlist');
});

test('X-Forwarded-Proto and X-Forwarded-Host shape the generated links', async () => {
  const r = await get(`${host}/get.php?username=joe&password=secret&output=m3u8`, {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'iptv.example.com' },
  });
  const body = await r.text();
  assert.ok(body.includes('https://iptv.example.com/live/joe/secret/'), 'builds links from the proxy headers');
  assert.match(body.split('\n')[2], /\.m3u8$/);
});
