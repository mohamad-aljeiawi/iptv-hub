// Configuration: everything is read from environment variables.
// See .env.example for a description of every setting.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// Minimal .env reader, no dependencies. Real environment variables always win
// (systemd passes the same file through EnvironmentFile, so this is a no-op there).
export function loadEnv(file = process.env.ENV_FILE || path.join(ROOT, '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m || line.trimStart().startsWith('#')) continue;
    const v = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}
loadEnv();

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

export const PORT = num(process.env.PORT, 8080);
export const HOST = process.env.HOST || '127.0.0.1';   // always behind a proxy, never bind 0.0.0.0
export const SYNC_HOURS = num(process.env.SYNC_HOURS, 6);
export const HEALTH_MIN = num(process.env.HEALTH_MIN, 5);
export const UA = process.env.UA || 'Mozilla/5.0';
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
export const DB_PATH = process.env.DB || path.join(ROOT, 'catalog.db');
export const ADMIN_TOKEN_ENV = process.env.ADMIN_TOKEN || '';

export const UNCAT = 999999;                            // id of the "uncategorised" bucket
export const UNCAT_NAME = 'أخرى';                       // user-facing: category label shown in players
