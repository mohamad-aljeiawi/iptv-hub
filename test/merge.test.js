// Merging: two servers carrying the same content produce one catalogue with no
// duplicates and two sources per item.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdb } from './helpers.js';

const env = tmpdb('merge');
let db, cleanupOrphans, syncServer, mocks;

before(async () => {
  ({ db, cleanupOrphans } = await import('../src/db.js'));
  ({ syncServer } = await import('../src/sync.js'));
  const { mockXtream, DEFAULTS } = await import('./mock-xtream.js');
  // Second server: the same movies written differently, plus one extra channel.
  const m1 = mockXtream({ name: 'one' });
  const m2 = mockXtream({ name: 'two', data: {
    live: [...DEFAULTS.live, { stream_id: 3, name: 'EN | Sky News HD', category_id: '10' }],
    vod: [
      { stream_id: 77, name: '[AR] the matrix 1999 4K', category_id: '20', container_extension: 'mp4', tmdb: '603' },
      { stream_id: 78, name: 'FR - Inception (2010) FHD', category_id: '20', container_extension: 'mkv' },
    ],
  } });
  mocks = [m1, m2];
  for (const [i, m] of mocks.entries()) {
    const url = await m.listen();
    db.prepare('INSERT INTO servers(id,name,url,username,password,latency) VALUES(?,?,?,?,?,?)').run(i + 1, m.name, url, 'test', 'test', (i + 1) * 10);
    await syncServer(i + 1);
  }
});
after(async () => { for (const m of mocks) await m.close(); env.cleanup(); });

test('identical movies collapse into a single item', () => {
  const rows = db.prepare("SELECT title, year FROM items WHERE type='vod' ORDER BY title").all();
  assert.equal(rows.length, 2, 'only two movies even though both servers carry them');
  assert.deepEqual(rows.map(r => r.title), ['Inception', 'The Matrix']);
});

test('a merged movie keeps both sources', () => {
  const n = db.prepare("SELECT count(*) c FROM sources WHERE item_id=(SELECT id FROM items WHERE title='The Matrix')").get().c;
  assert.equal(n, 2);
});

test('shared channels merge while unique ones survive', () => {
  const live = db.prepare("SELECT title FROM items WHERE type='live' ORDER BY title").all().map(r => r.title);
  assert.deepEqual(live.sort(), ['MBC 1', 'Sky News', 'بي ان سبورت 1'].sort());
});

test('similar categories from two servers become one category', () => {
  const n = db.prepare("SELECT count(*) c FROM categories WHERE type='live'").get().c;
  assert.equal(n, 1);
});

test('re-syncing a server creates no duplicates', async () => {
  const before = db.prepare('SELECT count(*) c FROM items').get().c;
  await syncServer(1);
  assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, before);
});

test('deleting a server keeps shared content and drops what only it had', () => {
  db.exec('BEGIN');
  db.prepare('DELETE FROM sources WHERE server_id=2').run();
  db.prepare('DELETE FROM servers WHERE id=2').run();
  db.exec('COMMIT');
  cleanupOrphans();
  const live = db.prepare("SELECT title FROM items WHERE type='live'").all().map(r => r.title);
  assert.ok(!live.includes('Sky News'), 'the deleted server\'s unique channel is gone');
  assert.ok(live.includes('MBC 1'), 'the shared channel stays');
});
