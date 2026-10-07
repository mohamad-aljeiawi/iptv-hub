// Shared test utilities: a throwaway database per test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be called before importing anything from src/, because config.js reads the
// environment at load time.
export function tmpdb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `iptvhub-${name}-`));
  process.env.DB = path.join(dir, 'test.db');
  process.env.ADMIN_TOKEN = 'test-admin-token';
  process.env.SYNC_HOURS = '999999';
  return {
    dir,
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the file */ } },
  };
}

export const get = async (url, opts = {}) => fetch(url, { redirect: 'manual', ...opts });
