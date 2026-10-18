// @ts-check
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDueEvents,
  applyEventNow,
  createEvent,
  createStock,
  deleteEvent,
  deleteStock,
  getMarket,
  getStockDetail,
  updateEvent,
  updateStock,
} from './store.js';
import { ApiError, asObject, validateEventInput, validateStockInput } from './validate.js';
import {
  canWrite,
  clearSessionCookie,
  createSession,
  destroySession,
  getCookie,
  getSessionUser,
  LoginLimiter,
  SESSION_COOKIE,
  sessionCookie,
} from './auth.js';
import {
  authenticate,
  changeOwnPassword,
  countUsers,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from './users.js';

/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */
/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./auth.js').CurrentUser} CurrentUser */

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY_BYTES = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** @returns {Record<string, string>} */
function securityHeaders() {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {unknown} data
 */
function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
  });
  res.end(JSON.stringify(data));
}

/**
 * @param {Req} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(req) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new ApiError(415, 'Erwartet JSON (Content-Type)');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'Anfrage ist zu groß');
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new ApiError(400, 'Ungültiges JSON');
  }
  return asObject(parsed);
}

/**
 * Blockiert Cross-Origin-Schreibzugriffe (zusätzlich zu SameSite=Strict).
 * @param {Req} req
 */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, 'Ungültiger Origin-Header');
  }
  if (originHost !== req.headers.host) throw new ApiError(403, 'Anfrage von fremder Herkunft blockiert');
}

/**
 * @param {string} path
 * @param {RegExp} pattern
 */
function match(path, pattern) {
  return path.match(pattern);
}

/** @param {CurrentUser} user */
function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

/**
 * @param {{ db: Db, config: Config, now?: () => Date }} deps
 */
export function createApp({ db, config, now = () => new Date() }) {
  const limiter = new LoginLimiter();

  /**
   * @param {Req} req
   * @param {Date} current
   * @returns {CurrentUser | null}
   */
  function currentUser(req, current) {
    return getSessionUser(db, getCookie(req.headers.cookie, SESSION_COOKIE), current);
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {URL} url
   */
  async function handleApi(req, res, url) {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const current = now();
    applyDueEvents(db, current);

    if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

    if (method === 'GET' && path === '/api/market') {
      return sendJson(res, 200, getMarket(db, current));
    }

    const stockMatch = match(path, /^\/api\/stocks\/([a-z0-9-]+)$/);
    if (stockMatch && method === 'GET') {
      const detail = getStockDetail(db, stockMatch[1] ?? '', current);
      if (!detail) throw new ApiError(404, 'Aktie nicht gefunden');
      return sendJson(res, 200, detail);
    }

    if (path.startsWith('/api/auth/')) {
      return handleAuth(req, res, path, method, current);
    }

    if (path.startsWith('/api/admin/')) {
      const user = currentUser(req, current);
      if (!user) throw new ApiError(401, 'Nicht angemeldet');
      return handleAdmin(req, res, path, method, current, user);
    }

    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {string} path
   * @param {string} method
   * @param {Date} current
   */
  async function handleAuth(req, res, path, method, current) {
    if (method === 'GET' && path === '/api/auth/status') {
      return sendJson(res, 200, {
        setupRequired: countUsers(db) === 0,
        user: (() => {
          const user = currentUser(req, current);
          return user ? publicUser(user) : null;
        })(),
      });
    }

    if (method === 'POST' && path === '/api/auth/setup') {
      const body = await readJson(req);
      // Die Ersteinrichtung legt immer ein Root-Konto an und ist nur einmal möglich.
      const id = await createUser(db, { username: body.username, password: body.password, role: 'root' }, { onlyIfEmpty: true, now: current });
      const user = { id, username: String(body.username).trim().toLowerCase(), role: /** @type {const} */ ('root') };
      const { token, expiresAt } = createSession(db, id, current);
      res.setHeader('Set-Cookie', sessionCookie(token, expiresAt, config.cookieSecure));
      return sendJson(res, 201, { user });
    }

    if (method === 'POST' && path === '/api/auth/login') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (limiter.isBlocked(ip, current)) {
        throw new ApiError(429, 'Zu viele Fehlversuche. Bitte später erneut versuchen.');
      }
      const body = await readJson(req);
      const user = await authenticate(db, body.username, body.password);
      if (!user) {
        limiter.recordFailure(ip, current);
        throw new ApiError(401, 'Benutzername oder Passwort ist falsch');
      }
      limiter.reset(ip);
      const { token, expiresAt } = createSession(db, user.id, current);
      res.setHeader('Set-Cookie', sessionCookie(token, expiresAt, config.cookieSecure));
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      destroySession(db, getCookie(req.headers.cookie, SESSION_COOKIE));
      res.setHeader('Set-Cookie', clearSessionCookie(config.cookieSecure));
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/api/auth/password') {
      const user = currentUser(req, current);
      if (!user) throw new ApiError(401, 'Nicht angemeldet');
      const body = await readJson(req);
      await changeOwnPassword(db, user.id, body.currentPassword, body.newPassword);
      res.setHeader('Set-Cookie', clearSessionCookie(config.cookieSecure));
      return sendJson(res, 200, { ok: true });
    }

    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {string} path
   * @param {string} method
   * @param {Date} current
   * @param {CurrentUser} user
   */
  async function handleAdmin(req, res, path, method, current, user) {
    if (path === '/api/admin/users' || path.startsWith('/api/admin/users/')) {
      if (user.role !== 'root') throw new ApiError(403, 'Nur das Root-Konto darf Benutzer verwalten');
      return handleUsers(req, res, path, method, user);
    }

    if (method !== 'GET' && !canWrite(user.role)) {
      throw new ApiError(403, 'Mit dieser Rolle ist nur Lesezugriff möglich');
    }

    let m;
    if (method === 'POST' && path === '/api/admin/stocks') {
      const input = validateStockInput(await readJson(req), current);
      const id = createStock(db, input, current);
      return sendJson(res, 201, { id });
    }
    if ((m = match(path, /^\/api\/admin\/stocks\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const input = validateStockInput(await readJson(req), current);
        updateStock(db, id, input);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        deleteStock(db, id);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (method === 'POST' && path === '/api/admin/events') {
      const input = validateEventInput(await readJson(req), current);
      const id = createEvent(db, input, current);
      return sendJson(res, 201, { id });
    }
    if ((m = match(path, /^\/api\/admin\/events\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const input = validateEventInput(await readJson(req), current);
        updateEvent(db, id, input, current);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        deleteEvent(db, id);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (method === 'POST' && (m = match(path, /^\/api\/admin\/events\/(\d+)\/apply$/))) {
      applyEventNow(db, Number(m[1]), current);
      return sendJson(res, 200, { ok: true });
    }
    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {string} path
   * @param {string} method
   * @param {CurrentUser} actor
   */
  async function handleUsers(req, res, path, method, actor) {
    if (method === 'GET' && path === '/api/admin/users') {
      return sendJson(res, 200, { users: listUsers(db) });
    }
    if (method === 'POST' && path === '/api/admin/users') {
      const body = await readJson(req);
      const id = await createUser(db, { username: body.username, password: body.password, role: body.role });
      return sendJson(res, 201, { id });
    }
    const m = match(path, /^\/api\/admin\/users\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const body = await readJson(req);
        await updateUser(db, id, { role: body.role, password: body.password });
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        deleteUser(db, id, actor.id);
        return sendJson(res, 200, { ok: true });
      }
    }
    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {string} pathname
   */
  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'Methode nicht erlaubt');
    let relative;
    try {
      relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    } catch {
      throw new ApiError(400, 'Ungültiger Pfad');
    }
    const file = resolve(PUBLIC_DIR, relative);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) throw new ApiError(404, 'Nicht gefunden');
    let target = file;
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('keine Datei');
    } catch {
      // Unbekannte Pfade ohne Dateiendung liefern die Startseite (Client-Routing).
      if (extname(relative) !== '') throw new ApiError(404, 'Nicht gefunden');
      target = resolve(PUBLIC_DIR, 'index.html');
    }
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[/** @type {keyof typeof MIME} */ (extname(target))] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...securityHeaders(),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /**
   * @param {Req} req
   * @param {Res} res
   */
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Interner Serverfehler' });
      }
    }
  };
}
