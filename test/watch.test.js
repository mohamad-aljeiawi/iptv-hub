// In-browser playback through the plain-HTTP watch page: the page is reachable
// only with a valid signed token, and its media links answer with a 302, so no
// video ever passes through this server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdb, get } from './helpers.js';

const env = tmpdb('watch');
let db, server, mock, upstream, host, cookie, watchToken;

before(async () => {
  ({ db } = await import('../src/db.js'));
  ({ watchToken } = await import('../src/watch.js'));
  const { syncServer } = await import('../src/sync.js');
  ({ server } = await import('../src/index.js'));
  const { mockXtream } = await import('./mock-xtream.js');
  mock = mockXtream({ name: 'one' });
  upstream = await mock.listen();
  db.prepare('INSERT INTO servers(id,name,url,username,password,latency) VALUES(1,?,?,?,?,10)').run('one', upstream, 'upuser', 'uppass');
  await syncServer(1);
  db.prepare('INSERT INTO users(id,username,password,max_conn,enabled,created) VALUES(1,?,?,1,1,?)').run('joe', 'secret', Date.now());
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${host}/api/login`, { method: 'POST', body: JSON.stringify({ username: 'joe', password: 'secret' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise(ok => server.close(ok));
  await mock.close();
  env.cleanup();
});

const vodId = () => db.prepare("SELECT id FROM items WHERE type='vod' ORDER BY id LIMIT 1").get().id;
const tokenFor = async id => (await (await get(`${host}/api/item/${id}`, { headers: { cookie } })).json()).watch;

test('the item API hands out a watch token', async () => {
  assert.match(await tokenFor(vodId()), /^[\w-]+\.[\w-]{22}$/);
});

test('the watch page plays /w links and never embeds upstream details', async () => {
  const t = await tokenFor(vodId());
  const r = await get(`${host}/watch/${t}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const html = await r.text();
  assert.ok(html.includes(`"token":"${t}"`));
  assert.ok(!html.includes(upstream) && !html.includes('upuser') && !html.includes('secret'), 'no upstream host, upstream login or user password');
});

test('a media link answers with a 302 straight to the provider', async () => {
  const t = await tokenFor(vodId());
  const src = db.prepare('SELECT id FROM sources WHERE item_id=?').get(vodId()).id;
  const r = await get(`${host}/w/${t}/${src}.mp4`);
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('location').startsWith(`${upstream}/movie/upuser/uppass/`));
});

test('an HTTPS visit to the watch page is sent down to HTTP', async () => {
  const t = await tokenFor(vodId());
  const r = await get(`${host}/watch/${t}`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'iptv.example.com' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `http://iptv.example.com/watch/${t}`);
});

test('forged, tampered and expired tokens are refused', async () => {
  const t = await tokenFor(vodId());
  const [body, sig] = t.split('.');
  const other = Buffer.from(`vod:${vodId()}:9999999999:admin`).toString('base64url');
  for (const bad of [`${body}.${'A'.repeat(22)}`, `${other}.${sig}`, 'nonsense']) {
    assert.equal((await get(`${host}/w/${bad}/1.mp4`)).status, 403, bad);
    assert.equal((await get(`${host}/watch/${bad}`)).status, 403, bad);
  }
  // Characters outside the token alphabet never match the route at all.
  assert.equal((await get(`${host}/w/${body}.é/1.mp4`)).status, 404);
  const old = watchToken('vod', vodId(), 'joe', Date.now() - 13 * 3600e3);
  assert.equal((await get(`${host}/w/${old}/1.mp4`)).status, 403, 'expired after 12 hours');
});

test('disabling the user kills their watch links', async () => {
  const t = await tokenFor(vodId());
  db.prepare('UPDATE users SET enabled=0 WHERE username=?').run('joe');
  try { assert.equal((await get(`${host}/w/${t}/1.mp4`)).status, 403); }
  finally { db.prepare('UPDATE users SET enabled=1 WHERE username=?').run('joe'); }
});

test('watch paths are not mistaken for short live links', async () => {
  const r = await get(`${host}/w/x.y/123.ts`);
  assert.equal(r.status, 403, 'handled by the watch router, not as user "w"');
});
