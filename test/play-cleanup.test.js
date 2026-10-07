// Session folders left behind by a crash are removed at startup, and nothing else
// in PLAY_DIR is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdb } from './helpers.js';

const env = tmpdb('play-cleanup');

test('startup removes stale session folders and only those', async () => {
  const dir = process.env.PLAY_DIR;
  const stale = ['Ab3_x-Yz09QwErTy', 'aaaaaaaaaaaaaaaa'];   // the shape of session ids
  for (const d of stale) fs.mkdirSync(path.join(dir, d, '1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'keep-me'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
  await import('../src/play.js');
  for (const d of stale) assert.ok(!fs.existsSync(path.join(dir, d)), `${d} removed`);
  assert.ok(fs.existsSync(path.join(dir, 'keep-me')), 'other folders kept');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'other files kept');
  env.cleanup();
});
