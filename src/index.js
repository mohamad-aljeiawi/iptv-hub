// Entry point: wire up the routers, start the server, schedule background jobs.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { PORT, HOST, SYNC_HOURS, HEALTH_MIN, DB_PATH } from './config.js';
import { adminPassword, schemaVersion } from './db.js';
import { createHandler } from './http.js';
import { healthCheck, refreshStale } from './sync.js';
import { xtreamRoutes, warm } from './xtream.js';
import { watchRoutes } from './watch.js';
import { apiRoutes, uiRoutes } from './api.js';

export const server = http.createServer(createHandler([xtreamRoutes, watchRoutes, uiRoutes, apiRoutes]));

export function start() {
  server.listen(PORT, HOST, () => {
    console.log(`IPTV Hub listening on http://${HOST}:${PORT}  (database: ${DB_PATH}, schema v${schemaVersion})`);
    console.log(`Admin login -> user: admin   password: ${adminPassword()}`);
  });
  refreshStale(SYNC_HOURS);
  setTimeout(warm, 1000);
  setInterval(() => refreshStale(SYNC_HOURS), 10 * 60e3);
  setTimeout(healthCheck, 30e3);
  setInterval(healthCheck, HEALTH_MIN * 60e3);

  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
  return server;
}

// Only start when run directly, never when imported by the tests.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) start();
