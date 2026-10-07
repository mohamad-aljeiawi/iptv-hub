// Search engine: prefix match + FTS + fuzzy fallback with a "did you mean".
import { db } from './db.js';
import { normText } from './normalize.js';
import { lru, onClear } from './http.js';

export const COLS = `i.id, i.type, i.title, i.norm, i.year, i.rating, i.poster IS NOT NULL AS has_img,
  (SELECT count(*) FROM sources s WHERE s.item_id=i.id) AS n_src`;

const cache = lru(1000);
onClear(() => cache.clear());   // after every sync

const trigrams = w => { const t = []; for (let i = 0; i + 3 <= w.length; i++) t.push(w.slice(i, i + 3)); return t; };

// Edit distance with adjacent transpositions, bailing out once max is exceeded.
export function osa(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

export function fuzzyMatch(qWords, norm) {
  const words = norm.split(' ');
  let hit = 0; const fix = [];
  for (const w of qWords) {
    const max = w.length <= 4 ? 1 : w.length <= 8 ? 2 : 3;
    const c = words.find(c => c.includes(w)) || words.find(c => osa(w, c, max) <= max)
      || words.find(c => c.length > w.length && osa(w, c.slice(0, w.length), max) <= max);
    if (c) hit++;
    fix.push(c && !c.includes(w) ? c : w);
  }
  return { sim: hit / qWords.length, fix };
}

const Q = {
  prefix: db.prepare('SELECT id, type, norm FROM items WHERE norm GLOB ? LIMIT 800'),
  wordStart: db.prepare('SELECT id, type, norm FROM items WHERE norm GLOB ? LIMIT 400'),
  fts: db.prepare('SELECT i.id, i.type, i.norm FROM (SELECT rowid FROM fts WHERE fts MATCH ? LIMIT 5000) f JOIN items i ON i.id=f.rowid'),
  fuzzy: db.prepare('SELECT i.id, i.type, i.norm FROM (SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT 600) f JOIN items i ON i.id=f.rowid'),
};

export function search(q, type, limit = 60) {
  const n = normText(q);
  if (!n) return { results: [], corrected: null };
  const ck = `${type}|${limit}|${n}`;
  const hit = cache.get(ck); if (hit) return hit;

  const found = new Map();
  let corrected = null;
  const add = (rows, tier) => { for (const r of rows) if ((!type || r.type === type) && !found.has(r.id)) found.set(r.id, { ...r, tier }); };
  const words = n.split(' ');

  add(Q.prefix.all(n + '*'), 4);                                         // starts with the phrase (indexed)
  if (n.replace(/ /g, '').length < 3) {
    if (found.size < 20) add(Q.wordStart.all('* ' + n + '*'), 3);
  } else {
    add(Q.fts.all(`"${n}"`), 3);                                         // phrase anywhere
    const long = words.filter(w => w.length >= 3);
    if (found.size < 100 && long.length > 1) add(Q.fts.all(long.map(w => `"${w}"`).join(' AND ')), 2); // all words, any order
    if (found.size < 10) {                                               // fuzzy + "did you mean"
      const variants = words.flatMap(w => w.length < 4 ? [w] : [w, ...[...w].map((_, i) => w.slice(0, i) + w.slice(i + 1))]);
      const grams = [...new Set(variants.flatMap(trigrams))];
      const votes = words.map(() => new Map());
      if (grams.length) for (const r of Q.fuzzy.all(grams.map(g => `"${g}"`).join(' OR '))) {
        const { sim, fix } = fuzzyMatch(words, r.norm);
        if (sim < (words.length > 2 ? 0.66 : 1)) continue;
        add([{ ...r, sim }], 1);
        fix.forEach((f, i) => votes[i].set(f, (votes[i].get(f) || 0) + 1));
      }
      const fixed = votes.map((v, i) => [...v].sort((a, b) => b[1] - a[1])[0]?.[0] || words[i]).join(' ');
      if (fixed !== n) {
        corrected = fixed;
        add(Q.prefix.all(fixed + '*'), 3);
        add(Q.fts.all(`"${fixed}"`), 2);
        const fl = fixed.split(' ').filter(w => w.length >= 3);
        if (fl.length > 1) add(Q.fts.all(fl.map(w => `"${w}"`).join(' AND ')), 2);
      }
    }
  }

  const scored = [...found.values()].map(r => {
    let score = r.tier * 10 + (r.sim || 0) * 3 - Math.abs(r.norm.length - n.length) * 0.05;
    if (r.norm === n) score += 15;
    else if (r.norm.startsWith(n + ' ')) score += 4;
    else if (r.norm.includes(' ' + n)) score += 2;
    return { id: r.id, type: r.type, score };
  }).sort((a, b) => b.score - a.score);

  const per = type ? limit : Math.ceil(limit / 2), taken = { live: 0, vod: 0, series: 0 }, top = [];
  for (const r of scored) if (taken[r.type]++ < per) top.push(r);
  if (!top.length) return cache.set(ck, { results: [], corrected });

  const score = new Map(top.map(r => [r.id, r.score]));
  const rows = db.prepare(`SELECT ${COLS} FROM items i WHERE i.id IN (${top.map(() => '?').join(',')})`).all(...top.map(r => r.id));
  const out = rows.map(r => ({ id: r.id, type: r.type, title: r.title, year: r.year, rating: r.rating, sources: r.n_src,
    img: r.has_img ? `/img/${r.id}` : null, score: +(score.get(r.id) + Math.min(r.n_src, 5) * 0.3).toFixed(2) }))
    .sort((a, b) => b.score - a.score);
  return cache.set(ck, { results: out, corrected });
}
