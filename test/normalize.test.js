// Name cleaning decides whether two entries from two servers are the same thing.
// The Arabic strings below are test data, not prose: they exercise the folding rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normText, parseName, parseCategory, nameKeyOf } from '../src/normalize.js';

test('normText folds alef/yeh/teh-marbuta and strips diacritics and punctuation', () => {
  assert.equal(normText('أحمد'), normText('احمد'));
  assert.equal(normText('مُحَمَّد'), normText('محمد'));
  assert.equal(normText('قناة الجزيرة'), normText('قناه الجزيره'));
  assert.equal(normText('مصــر'), 'مصر');
  assert.equal(normText('Movie: The-Matrix!'), 'movie the matrix');
  assert.equal(normText('١٢٣'), '123');
});

test('parseName strips country prefixes and quality tags', () => {
  assert.equal(parseName('[AR] MBC 1 FHD', 'live').title, 'MBC 1');
  assert.equal(parseName('AR: بي ان سبورت 1 HD', 'live').title, 'بي ان سبورت 1');
  assert.equal(parseName('|EN| CNN HD', 'live').title, 'CNN');
  assert.equal(parseName('FR - TF1 4K', 'live').quality, '4K');
});

test('parseName extracts the year for movies but not for channels', () => {
  const vod = parseName('The Matrix (1999) 1080p', 'vod');
  assert.equal(vod.year, '1999');
  assert.equal(vod.title, 'The Matrix');
  assert.equal(parseName('Sky News 2020', 'live').year, null);
});

test('parseName ignores decorative divider entries', () => {
  assert.equal(parseName('=== قنوات رياضية ===', 'live'), null);
  assert.equal(parseName('••••••', 'live'), null);
  assert.equal(parseName('', 'live'), null);
});

test('the same title from different servers yields the same merge key', () => {
  const a = parseName('[AR] The Matrix (1999) FHD', 'vod');
  const b = parseName('EN - the matrix 1999 1080p', 'vod');
  assert.equal(nameKeyOf('vod', a.norm, a.year), nameKeyOf('vod', b.norm, b.year));
});

test('different titles are not merged', () => {
  const a = parseName('The Matrix (1999)', 'vod');
  const b = parseName('The Matrix Reloaded (2003)', 'vod');
  assert.notEqual(nameKeyOf('vod', a.norm, a.year), nameKeyOf('vod', b.norm, b.year));
});

test('parseCategory cleans category names', () => {
  assert.equal(parseCategory('|AR| قنوات عربية').norm, parseCategory('AR - قنوات عربيه').norm);
  assert.equal(parseCategory('###'), null);
});
