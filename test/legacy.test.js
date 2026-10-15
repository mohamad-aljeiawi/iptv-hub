// The fallback for old browsers (public/legacy/): it must match the page script it was
// built from, stay plain ES5 where it is hand-written, and be served with a version.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { tmpdb } from './helpers.js';
import { pageScript, VERSION_RE, legacyVersion, LEGACY_FILES } from '../scripts/build-legacy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
const html = read('index.html');
const bootstrap = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];

test('legacy/app.js was built from the current page script (run npm run build:legacy)', () => {
  const sha = createHash('sha256').update(pageScript(html)).digest('hex');
  assert.match(read('legacy/app.js'), new RegExp(`^// source-sha256: ${sha}$`, 'm'));
});

test('the bootstrap loads the current version of the legacy files (run npm run build:legacy)', () => {
  const want = legacyVersion(LEGACY_FILES.map(f => read(`legacy/${f}`)));
  assert.equal(html.match(VERSION_RE)?.[1], want);
});

test('the bootstrap and the polyfills are plain ES5', () => {
  for (const [name, code] of [['bootstrap', bootstrap], ['polyfills.js', read('legacy/polyfills.js')]]) {
    assert.doesNotThrow(() => new vm.Script(code), name);
    // Comments aside, nothing newer than ES5: arrows, let/const, classes, template
    // strings, spread. The ES2021 inside the bootstrap's feature test is a string.
    const bare = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'/g, "''");
    assert.doesNotMatch(bare, /=>|\b(?:let|const|class)\s|`|\.\.\./, name);
  }
});

const env = tmpdb('legacy');
let server, host;
before(async () => {
  ({ server } = await import('../src/index.js'));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(ok => server.close(ok)); env.cleanup(); });

test('legacy files are served compressed, typed and cacheable without logging in', async () => {
  for (const [f, type] of [['app.js', 'text/javascript'], ['polyfills.js', 'text/javascript'], ['legacy.css', 'text/css']]) {
    const r = await fetch(`${host}/legacy/${f}?v=abc`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type'), new RegExp(`^${type}`), f);
    assert.match(r.headers.get('cache-control'), /immutable/, f);
    assert.equal(r.headers.get('content-encoding'), 'gzip', f);
    assert.equal(await r.text(), read(`legacy/${f}`), f);
  }
});

test('nothing else under /legacy/ is served', async () => {
  for (const p of ['/legacy/', '/legacy/other.js', '/legacy/..%2Findex.html', '/legacy/app.js.map']) {
    assert.equal((await fetch(host + p)).status, 404, p);
  }
});
