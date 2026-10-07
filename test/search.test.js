// Search: exact match, partial name, Arabic without diacritics, and typos.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdb } from './helpers.js';

const env = tmpdb('search');
let search, db;

before(async () => {
  ({ db } = await import('../src/db.js'));
  ({ search } = await import('../src/search.js'));
  const { parseName } = await import('../src/normalize.js');
  const ins = db.prepare('INSERT INTO items(type,title,norm,year) VALUES(?,?,?,?)');
  const fts = db.prepare('INSERT INTO fts(rowid,norm) VALUES(?,?)');
  const src = db.prepare('INSERT INTO sources(item_id,server_id,type,stream_id) VALUES(?,1,?,?)');
  for (const [type, raw] of [
    ['vod', 'The Matrix (1999)'], ['vod', 'The Matrix Reloaded (2003)'], ['vod', 'Inception (2010)'],
    ['vod', 'Interstellar (2014)'], ['live', 'قناة الجزيرة الإخبارية'], ['live', 'MBC 1'],
    ['series', 'Breaking Bad (2008)'],
  ]) {
    const p = parseName(raw, type);
    const id = Number(ins.run(type, p.title, p.norm, p.year).lastInsertRowid);
    fts.run(id, p.norm);
    src.run(id, type, String(id));
  }
});
after(() => env.cleanup());

const titles = q => search(q, '', 20).results.map(r => r.title);

test('an exact match ranks first', () => {
  assert.equal(titles('the matrix')[0], 'The Matrix');
});

test('searching by part of the name works', () => {
  assert.ok(titles('matrix').includes('The Matrix Reloaded'));
  assert.ok(titles('incep').includes('Inception'));
});

test('Arabic search ignores diacritics and hamza form', () => {
  assert.ok(titles('الجزيره').includes('قناة الجزيرة الإخبارية'));
  assert.ok(titles('الجزيرة').length > 0);
});

test('fuzzy search recovers from a typo', () => {
  const r = search('intersteller', '', 20);
  assert.ok(r.results.some(x => x.title === 'Interstellar'), 'found despite the misspelling');
});

test('filtering by type', () => {
  const r = search('matrix', 'live', 20);
  assert.equal(r.results.length, 0);
  assert.ok(search('matrix', 'vod', 20).results.length >= 2);
});

test('an empty query returns no results and does not throw', () => {
  assert.deepEqual(search('   ', '', 20).results, []);
});
