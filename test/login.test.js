// Login rate limiting: the in-app limit must key on the address the proxy saw,
// not on anything the client can put in X-Forwarded-For.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdb } from './helpers.js';

const env = tmpdb('login');
let server, clientIp, host;

before(async () => {
  ({ clientIp } = await import('../src/http.js'));
  ({ server } = await import('../src/index.js'));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  host = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(ok => server.close(ok));
  env.cleanup();
});

const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });

test('behind a proxy, the last X-Forwarded-For entry is the client', () => {
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(clientIp(req('172.18.0.1', '1.2.3.4, 203.0.113.7')), '203.0.113.7', 'Docker gateway');
  assert.equal(clientIp(req('::ffff:127.0.0.1', 'forged, 203.0.113.7')), '203.0.113.7');
});

test('a direct connection ignores X-Forwarded-For entirely', () => {
  assert.equal(clientIp(req('198.51.100.9', '127.0.0.1')), '198.51.100.9');
  assert.equal(clientIp(req('198.51.100.9')), '198.51.100.9');
});

test('rotating the client-supplied part of X-Forwarded-For does not escape the limit', async () => {
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const r = await fetch(`${host}/api/login`, {
      method: 'POST',
      // What nginx forwards when the client sends its own X-Forwarded-For:
      // the forged value first, the real address appended last.
      headers: { 'x-forwarded-for': `10.9.9.${i}, 203.0.113.50` },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429]);
});
