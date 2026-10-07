// Database, migrations, accounts and sessions.
// Migrations are numbered and applied automatically at startup, so no update can
// break existing data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ADMIN_TOKEN_ENV } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;');

// ───────────────────────── migrations ─────────────────────────
// Only ever append to this array. Never edit a migration that already shipped.
const MIGRATIONS = [
  // 1 — base schema
  d => d.exec(`
    CREATE TABLE IF NOT EXISTS servers(id INTEGER PRIMARY KEY, name TEXT, url TEXT, username TEXT, password TEXT,
      status TEXT, exp_date INTEGER, max_conn INTEGER, latency INTEGER, last_sync INTEGER, error TEXT);
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, max_conn INTEGER DEFAULT 1,
      exp_date INTEGER, enabled INTEGER DEFAULT 1, created INTEGER);
    CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, type TEXT, name TEXT, norm TEXT, UNIQUE(type, norm));
    CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, type TEXT, title TEXT, norm TEXT, year TEXT,
      tmdb INTEGER, poster TEXT, rating REAL, added INTEGER);
    CREATE TABLE IF NOT EXISTS keys(key TEXT PRIMARY KEY, item_id INTEGER) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, item_id INTEGER, server_id INTEGER, type TEXT,
      stream_id TEXT, ext TEXT, raw_name TEXT, category TEXT, quality TEXT, UNIQUE(server_id, type, stream_id));
    CREATE TABLE IF NOT EXISTS vepisodes(vid INTEGER PRIMARY KEY, item_id INTEGER, season INTEGER, num INTEGER, UNIQUE(item_id, season, num));
    CREATE INDEX IF NOT EXISTS src_item ON sources(item_id);
    CREATE INDEX IF NOT EXISTS items_latest ON items(type, added DESC);
    CREATE INDEX IF NOT EXISTS items_norm ON items(norm);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(norm, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT, exp INTEGER);`),

  // 2 — categories, container extensions and EPG channel ids
  d => {
    for (const [t, c] of [['items', 'category_id INTEGER'], ['items', 'ext TEXT'], ['items', 'epg TEXT'], ['sources', 'epg TEXT']]) {
      try { d.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch { /* column already exists */ }
    }
    d.exec('CREATE INDEX IF NOT EXISTS items_cat ON items(type, category_id);');
  },

  // 3 — drop expired sessions
  d => d.exec("DELETE FROM kv WHERE k LIKE 'sess:%' AND exp IS NOT NULL AND exp < strftime('%s','now')*1000"),
];

export function migrate(d = db) {
  const version = d.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    MIGRATIONS[i](d);
    d.exec(`PRAGMA user_version=${i + 1}`);
  }
  return MIGRATIONS.length;
}
export const schemaVersion = migrate();

// ───────────────────────── key/value store ─────────────────────────
export const kvGet = k => {
  const r = db.prepare('SELECT v, exp FROM kv WHERE k=?').get(k);
  return r && (!r.exp || r.exp > Date.now()) ? r.v : null;
};
export const kvSet = (k, v, ttl) => db.prepare('INSERT OR REPLACE INTO kv(k,v,exp) VALUES(?,?,?)').run(k, v, ttl ? Date.now() + ttl : null);
export const kvDel = k => db.prepare('DELETE FROM kv WHERE k=?').run(k);

// Durable cache: survives restarts. Used for upstream series and movie metadata.
export async function kvCache(key, ttl, build) {
  const hit = kvGet(key);
  if (hit) return JSON.parse(hit);
  const v = await build();
  kvSet(key, JSON.stringify(v), ttl);
  return v;
}

// ───────────────────────── admin password ─────────────────────────
// From the environment if set, otherwise generated once and stored in the database.
let adminToken = ADMIN_TOKEN_ENV || kvGet('admin_token');
if (!adminToken) { adminToken = crypto.randomBytes(9).toString('base64url'); kvSet('admin_token', adminToken); }
export const adminPassword = () => adminToken;
export function setAdminPassword(next) {
  adminToken = String(next);
  kvSet('admin_token', adminToken);
  db.prepare("DELETE FROM kv WHERE k LIKE 'sess:%'").run();   // invalidate every session
  return adminToken;
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
export const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ───────────────────────── shared statements ─────────────────────────
export const serverById = id => db.prepare('SELECT * FROM servers WHERE id=?').get(id);
export const itemById = id => db.prepare('SELECT * FROM items WHERE id=?').get(id);
export const base = s => s.url.replace(/\/+$/, '');

// ───────────────────────── users and sessions ─────────────────────────
export function checkUser(u, p) {
  if (!u || !p) return null;
  if (u === 'admin') return safeEq(p, adminToken) ? { id: 0, username: 'admin', password: p, max_conn: 99, exp_date: null, admin: true } : null;
  const r = db.prepare('SELECT * FROM users WHERE username=?').get(u);
  if (!r || !r.enabled || !safeEq(p, r.password)) return null;
  if (r.exp_date && r.exp_date * 1000 < Date.now()) return null;
  return { ...r, admin: false };
}

export function session(req) {
  const sid = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  const v = sid && kvGet('sess:' + sid);
  if (!v) return null;
  const s = JSON.parse(v);
  if (s.admin) return { sid, id: 0, username: 'admin', password: adminToken, admin: true };
  const r = db.prepare('SELECT * FROM users WHERE id=?').get(s.uid);
  if (!r || !r.enabled || (r.exp_date && r.exp_date * 1000 < Date.now())) return null;
  return { sid, ...r, admin: false };
}

export function newSession(user) {
  const sid = crypto.randomBytes(24).toString('base64url');
  kvSet('sess:' + sid, JSON.stringify({ uid: user.id, admin: user.admin }), 30 * 86400e3);
  return sid;
}

// Drop items that lost their last source after a server was removed or re-synced.
export function cleanupOrphans() {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS orphan(id INTEGER PRIMARY KEY);
    DELETE FROM orphan;
    INSERT INTO orphan SELECT id FROM items WHERE id NOT IN (SELECT item_id FROM sources);
    DELETE FROM fts WHERE rowid IN (SELECT id FROM orphan);
    DELETE FROM keys WHERE item_id IN (SELECT id FROM orphan);
    DELETE FROM vepisodes WHERE item_id IN (SELECT id FROM orphan);
    DELETE FROM items WHERE id IN (SELECT id FROM orphan);
    DELETE FROM categories WHERE id NOT IN (SELECT category_id FROM items WHERE category_id IS NOT NULL);`);
}
