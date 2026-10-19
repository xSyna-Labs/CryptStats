// @ts-check
// Muss vor allen anderen Imports stehen: prüft die Node-Version, bevor node:sqlite geladen wird.
import './require-node.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createAssetFetcher } from './assets.js';
import { openSqliteDatabase } from './sqlite-d1.js';
import { applyDueEvents } from './store.js';
import { countUsers } from './users.js';
import { VERSION } from './version.js';

/** @typedef {import('node:http').IncomingMessage} Incoming */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

const SCHEDULER_INTERVAL_MS = 15_000;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function loadServerConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT muss eine Zahl zwischen 0 und 65535 sein');
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dbPath: resolve(env.DB_PATH ?? 'data/cryptstats.db'),
    // Hinter einem TLS-Proxy auf true setzen; lokale HTTP-Installationen brauchen false.
    cookieSecure: env.COOKIE_SECURE === 'true',
  };
}

/**
 * Baut aus einer Node-Anfrage einen Web-Request. Die Verbindungs-IP wird als
 * `cf-connecting-ip` gesetzt, damit die Login-Sperre auch ohne Cloudflare greift.
 * @param {Incoming} req
 */
async function toRequest(req) {
  const host = req.headers.host ?? 'localhost';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  headers.set('cf-connecting-ip', req.socket.remoteAddress ?? 'unknown');

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(/** @type {Buffer} */ (chunk));
    body = Buffer.concat(chunks);
  }
  return new Request(new URL(req.url ?? '/', `http://${host}`), {
    method: req.method,
    headers,
    body,
  });
}

/**
 * @param {ServerResponse} res
 * @param {Response} response
 * @param {boolean} headOnly
 */
async function sendResponse(res, response, headOnly) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);

  const body = Buffer.from(await response.arrayBuffer());
  res.setHeader('Content-Length', String(body.length));
  res.end(headOnly ? undefined : body);
}

/**
 * @param {ReturnType<typeof loadServerConfig>} [config]
 */
export async function startServer(config = loadServerConfig()) {
  const db = openSqliteDatabase(config.dbPath);
  const app = createApp({
    db,
    config: { cookieSecure: config.cookieSecure },
    assets: createAssetFetcher(PUBLIC_DIR),
  });

  const server = createServer(async (req, res) => {
    try {
      const response = await app(await toRequest(req));
      await sendResponse(res, response, req.method === 'HEAD');
    } catch (err) {
      console.error('Anfrage fehlgeschlagen:', err);
      if (!res.headersSent) res.statusCode = 500;
      res.end('Interner Serverfehler');
    }
  });

  const timer = setInterval(() => {
    applyDueEvents(db).catch((err) => console.error('Scheduler-Fehler:', err));
  }, SCHEDULER_INTERVAL_MS);

  server.on('close', () => {
    clearInterval(timer);
    db.close();
  });

  await new Promise((resolvePromise) => server.listen(config.port, config.host, () => resolvePromise(undefined)));

  const users = await countUsers(db);
  console.log(`CryptStats v${VERSION} läuft auf http://${config.host}:${config.port}`);
  console.log(`Datenbank: ${config.dbPath}`);
  if (users === 0) {
    console.log('Ersteinrichtung: /#/admin öffnen und das Root-Konto anlegen.');
  }
  return server;
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
