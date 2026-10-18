// @ts-check
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { applyDueEvents } from './store.js';
import { countUsers } from './users.js';

const SCHEDULER_INTERVAL_MS = 15_000;

/**
 * @param {ReturnType<typeof loadConfig>} [config]
 */
export function startServer(config = loadConfig()) {
  const db = openDatabase(config.dbPath);
  const app = createApp({ db, config });
  const server = createServer(app);

  const timer = setInterval(() => {
    try {
      applyDueEvents(db);
    } catch (err) {
      console.error('Scheduler-Fehler:', err);
    }
  }, SCHEDULER_INTERVAL_MS);

  server.on('close', () => {
    clearInterval(timer);
    db.close();
  });

  return new Promise((resolvePromise) => {
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      console.log(`CryptStats läuft auf http://${config.host}:${port}`);
      if (countUsers(db) === 0) {
        console.log(`Ersteinrichtung: http://localhost:${port}/#/admin öffnen und das Root-Konto anlegen.`);
      }
      resolvePromise(server);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startServer()
    .then((server) => {
      const shutdown = () => server.close(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
