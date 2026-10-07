// Development mode: two mock Xtream servers plus the app with auto-reload.
// Run with: npm run dev
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockXtream } from '../test/mock-xtream.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mocks = [mockXtream({ name: 'mock1' }), mockXtream({ name: 'mock2' })];

const urls = [];
for (const m of mocks) urls.push(await m.listen());

console.log('Mock Xtream servers (username: test, password: test):');
for (const u of urls) console.log('  ' + u);
console.log('Add them from the Settings tab once the site is open.\n');

// Development defaults; a .env file, if present, takes precedence.
const defaults = fs.existsSync(path.join(ROOT, '.env'))
  ? {}
  : { DB: path.join(ROOT, 'dev.db'), ADMIN_TOKEN: 'dev', PORT: '8080' };

const child = spawn(process.execPath, ['--no-warnings', '--watch', path.join(ROOT, 'src', 'index.js')], {
  stdio: 'inherit',
  env: { ...defaults, ...process.env },
});

const stop = () => { child.kill(); Promise.all(mocks.map(m => m.close())).then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', code => { Promise.all(mocks.map(m => m.close())).then(() => process.exit(code ?? 0)); });
