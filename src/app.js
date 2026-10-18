// @ts-check
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

/** @typedef {import('./types.js').D1Database} D1Database */
/** @typedef {import('./types.js').AssetFetcher} AssetFetcher */
/** @typedef {{ cookieSecure: boolean }} Config */
/** @typedef {import('./auth.js').CurrentUser} CurrentUser */

const MAX_BODY_BYTES = 64 * 1024;

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
 * @param {Response} response
 * @returns {Response}
 */
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [extraHeaders]
 */
function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...securityHeaders(),
      ...extraHeaders,
    },
  });
}

/**
 * @param {Request} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('application/json')) throw new ApiError(415, 'Erwartet JSON (Content-Type)');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, 'Anfrage ist zu groß');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new ApiError(413, 'Anfrage ist zu groß');
  }
  let parsed;
  try {
    parsed = JSON.parse(text || 'null');
  } catch {
    throw new ApiError(400, 'Ungültiges JSON');
  }
  return asObject(parsed);
}

/**
 * Blockiert Cross-Origin-Schreibzugriffe (zusätzlich zu SameSite=Strict).
 * @param {Request} request
 * @param {URL} url
 */
function assertSameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ApiError(403, 'Ungültiger Origin-Header');
  }
  if (originUrl.host !== url.host) throw new ApiError(403, 'Anfrage von fremder Herkunft blockiert');
}

/** @param {string} path */
function looksLikeFile(path) {
  const last = path.split('/').pop() ?? '';
  return last.includes('.');
}

/** @param {CurrentUser} user */
function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

/**
 * @param {{ db: D1Database, config: Config, assets?: AssetFetcher, now?: () => Date }} deps
 */
export function createApp({ db, config, assets, now = () => new Date() }) {
  const limiter = new LoginLimiter();

  /**
   * @param {Request} request
   * @param {Date} current
   * @returns {Promise<CurrentUser | null>}
   */
  async function currentUser(request, current) {
    return getSessionUser(db, getCookie(request.headers.get('cookie') ?? undefined, SESSION_COOKIE), current);
  }

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {Date} current
   */
  async function handleAuth(request, url, current) {
    const method = request.method;
    const path = url.pathname;

    if (method === 'GET' && path === '/api/auth/status') {
      const user = await currentUser(request, current);
      return json(200, {
        setupRequired: (await countUsers(db)) === 0,
        user: user ? publicUser(user) : null,
      });
    }

    if (method === 'POST' && path === '/api/auth/setup') {
      const body = await readJson(request);
      // Die Ersteinrichtung legt immer ein Root-Konto an und ist nur einmal möglich.
      const id = await createUser(
        db,
        { username: body.username, password: body.password, role: 'root' },
        { onlyIfEmpty: true, now: current },
      );
      const user = {
        id,
        username: String(body.username).trim().toLowerCase(),
        role: /** @type {const} */ ('root'),
      };
      const { token, expiresAt } = await createSession(db, id, current);
      return json(201, { user }, { 'Set-Cookie': sessionCookie(token, expiresAt, config.cookieSecure) });
    }

    if (method === 'POST' && path === '/api/auth/login') {
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (limiter.isBlocked(ip, current)) {
        throw new ApiError(429, 'Zu viele Fehlversuche. Bitte später erneut versuchen.');
      }
      const body = await readJson(request);
      const user = await authenticate(db, body.username, body.password);
      if (!user) {
        limiter.recordFailure(ip, current);
        throw new ApiError(401, 'Benutzername oder Passwort ist falsch');
      }
      limiter.reset(ip);
      const { token, expiresAt } = await createSession(db, user.id, current);
      return json(200, { user: publicUser(user) }, {
        'Set-Cookie': sessionCookie(token, expiresAt, config.cookieSecure),
      });
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      await destroySession(db, getCookie(request.headers.get('cookie') ?? undefined, SESSION_COOKIE));
      return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie(config.cookieSecure) });
    }

    if (method === 'POST' && path === '/api/auth/password') {
      const user = await currentUser(request, current);
      if (!user) throw new ApiError(401, 'Nicht angemeldet');
      const body = await readJson(request);
      await changeOwnPassword(db, user.id, body.currentPassword, body.newPassword);
      return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie(config.cookieSecure) });
    }

    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {Date} current
   * @param {CurrentUser} user
   */
  async function handleAdmin(request, url, current, user) {
    const method = request.method;
    const path = url.pathname;

    if (path === '/api/admin/users' || path.startsWith('/api/admin/users/')) {
      if (user.role !== 'root') throw new ApiError(403, 'Nur das Root-Konto darf Benutzer verwalten');
      return handleUsers(request, url, user);
    }

    if (method !== 'GET' && method !== 'HEAD' && !canWrite(user.role)) {
      throw new ApiError(403, 'Mit dieser Rolle ist nur Lesezugriff möglich');
    }

    let m;
    if (method === 'POST' && path === '/api/admin/stocks') {
      const input = validateStockInput(await readJson(request), current);
      const id = await createStock(db, input, current);
      return json(201, { id });
    }
    if ((m = path.match(/^\/api\/admin\/stocks\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const input = validateStockInput(await readJson(request), current);
        await updateStock(db, id, input);
        return json(200, { ok: true });
      }
      if (method === 'DELETE') {
        await deleteStock(db, id);
        return json(200, { ok: true });
      }
    }
    if (method === 'POST' && path === '/api/admin/events') {
      const input = validateEventInput(await readJson(request), current);
      const id = await createEvent(db, input, current);
      return json(201, { id });
    }
    if ((m = path.match(/^\/api\/admin\/events\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const input = validateEventInput(await readJson(request), current);
        await updateEvent(db, id, input, current);
        return json(200, { ok: true });
      }
      if (method === 'DELETE') {
        await deleteEvent(db, id);
        return json(200, { ok: true });
      }
    }
    if (method === 'POST' && (m = path.match(/^\/api\/admin\/events\/(\d+)\/apply$/))) {
      await applyEventNow(db, Number(m[1]), current);
      return json(200, { ok: true });
    }
    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {CurrentUser} actor
   */
  async function handleUsers(request, url, actor) {
    const method = request.method;
    if (method === 'GET' && url.pathname === '/api/admin/users') {
      return json(200, { users: await listUsers(db) });
    }
    if (method === 'POST' && url.pathname === '/api/admin/users') {
      const body = await readJson(request);
      const id = await createUser(db, { username: body.username, password: body.password, role: body.role });
      return json(201, { id });
    }
    const m = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const body = await readJson(request);
        await updateUser(db, id, { role: body.role, password: body.password });
        return json(200, { ok: true });
      }
      if (method === 'DELETE') {
        await deleteUser(db, id, actor.id);
        return json(200, { ok: true });
      }
    }
    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {Date} current
   */
  async function handleApi(request, url, current) {
    const method = request.method;
    const path = url.pathname;
    await applyDueEvents(db, current);

    if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(request, url);

    if (method === 'GET' && path === '/api/market') {
      return json(200, await getMarket(db, current));
    }

    const stockMatch = path.match(/^\/api\/stocks\/([a-z0-9-]+)$/);
    if (stockMatch && method === 'GET') {
      const detail = await getStockDetail(db, stockMatch[1] ?? '', current);
      if (!detail) throw new ApiError(404, 'Aktie nicht gefunden');
      return json(200, detail);
    }

    if (path.startsWith('/api/auth/')) {
      return handleAuth(request, url, current);
    }

    if (path.startsWith('/api/admin/')) {
      const user = await currentUser(request, current);
      if (!user) throw new ApiError(401, 'Nicht angemeldet');
      return handleAdmin(request, url, current, user);
    }

    throw new ApiError(404, 'Nicht gefunden');
  }

  /**
   * @param {Request} request
   * @param {URL} url
   */
  async function serveStatic(request, url) {
    if (!assets) {
      return new Response('Nicht gefunden', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() },
      });
    }
    const response = await assets.fetch(request);
    if (response.status !== 404) return withSecurityHeaders(response);
    // Unbekannte Pfade ohne Dateiendung liefern die Startseite (Client-Routing über den Hash).
    if (looksLikeFile(url.pathname)) {
      return new Response('Nicht gefunden', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() },
      });
    }
    const indexUrl = new URL('/', url);
    const index = await assets.fetch(
      new Request(indexUrl.toString(), { method: request.method, headers: request.headers }),
    );
    return withSecurityHeaders(index);
  }

  /** @param {Request} request */
  return async function handle(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, url, now());
      }
      return await serveStatic(request, url);
    } catch (err) {
      if (err instanceof ApiError) {
        return json(err.status, { error: err.message });
      }
      console.error(err);
      return json(500, { error: 'Interner Serverfehler' });
    }
  };
}
