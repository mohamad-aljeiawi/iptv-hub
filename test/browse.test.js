// The browse pages' API: categories with counts, and paged titles per category.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdb } from './helpers.js';

const env = tmpdb('browse');
let db, server, mock, host, cookie;

before(async () => {
  ({ db } = await import('../src/db.js'));
  const { syncServer } = await import('../src/sync.js');
  ({ server } = await import('../src/index.js'));
  const { mockXtream } = await import('./mock-xtream.js');
  const vod = Array.from({ length: 25 }, (_, i) => ({ stream_id: 100 + i, name: `Film Number ${i} (${2000 + i})`, category_id: i % 5 ? '20' : '21',
    container_extension: 'mp4', added: String(1700000000 + i) }));
  mock = mockXtream({ name: 'one', data: { vod, cats: { vod: [{ category_id: '20', category_name: 'EN Movies' }, { category_id: '21', category_name: 'AR Movies' }] } } });
  db.prepare('INSERT INTO servers(id,name,url,username,password) VALUES(1,?,?,?,?)').run('one', await mock.listen(), 'u', 'p');
  await syncServer(1);
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
  cookie = (await fetch(`${host}/api/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'test-admin-token' }) }))
    .headers.get('set-cookie').split(';')[0];
});
after(async () => { await new Promise(ok => server.close(ok)); await mock.close(); env.cleanup(); });

const get = path => fetch(host + path, { headers: { cookie } }).then(r => r.json());

test('categories come with their title counts, largest first', async () => {
  const cats = await get('/api/categories?type=vod');
  assert.deepEqual(cats.map(c => [c.name, c.n]), [['EN Movies', 20], ['AR Movies', 5]]);
});

test('titles come in pages, newest first, with a "more" flag', async () => {
  const p1 = await get('/api/browse?type=vod&limit=10');
  assert.equal(p1.items.length, 10);
  assert.equal(p1.more, true);
  assert.equal(p1.items[0].title, 'Film Number 24');
  const p3 = await get('/api/browse?type=vod&limit=10&offset=20');
  assert.equal(p3.items.length, 5);
  assert.equal(p3.more, false);
});

test('a category filters the titles', async () => {
  const cats = await get('/api/categories?type=vod');
  const ar = cats.find(c => c.name === 'AR Movies');
  const page = await get(`/api/browse?type=vod&cat=${ar.id}`);
  assert.equal(page.items.length, 5);
  assert.ok(page.items.every(i => /Film Number (0|5|10|15|20)$/.test(i.title)));
});

test('the browse API needs a login', async () => {
  assert.equal((await fetch(`${host}/api/browse?type=vod`)).status, 401);
});
