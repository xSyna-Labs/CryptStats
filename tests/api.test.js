import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

const ROOT_NAME = 'root';
const ROOT_PASSWORD = 'root-passwort-123';
const ADMIN_PASSWORD = 'admin-passwort-123';
const VIEWER_PASSWORD = 'viewer-passwort-123';
const START_CLOCK = new Date('2026-01-01T10:00:00.000Z');

/** @type {import('node:http').Server} */
let server;
let base = '';
/** @type {Db} */
let db;
const clock = { now: START_CLOCK };

before(async () => {
  db = openDatabase(':memory:');
  const app = createApp({
    db,
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', cookieSecure: false },
    now: () => clock.now,
  });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  db.close();
});

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [options]
 */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  /** @type {{ method: string, headers: Record<string, string>, body?: string }} */
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/**
 * Meldet ein Konto an und liefert das Session-Cookie.
 * @param {string} username
 * @param {string} password
 */
async function login(username, password) {
  const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `Login von ${username} sollte gelingen`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('public pages and first-run setup', () => {
  it('serves the app shell with security headers and refuses traversal', async () => {
    const res = await api('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(res.text, /CryptStats/);
    assert.equal((await api('/..%2Fpackage.json')).status, 404);
    assert.equal((await api('/missing.txt')).status, 404);
  });

  it('reports setupRequired before any account exists', async () => {
    const status = await api('/api/auth/status');
    assert.equal(status.json.setupRequired, true);
    assert.equal(status.json.user, null);
  });

  it('blocks admin writes and reads without a session', async () => {
    assert.equal((await api('/api/admin/stocks', { method: 'POST', body: { name: 'X', symbol: 'XX' } })).status, 401);
  });

  it('rejects a too short password during setup', async () => {
    const res = await api('/api/auth/setup', { method: 'POST', body: { username: ROOT_NAME, password: 'kurz' } });
    assert.equal(res.status, 400);
  });

  it('creates the root account on first setup and logs it in', async () => {
    const res = await api('/api/auth/setup', { method: 'POST', body: { username: ROOT_NAME, password: ROOT_PASSWORD } });
    assert.equal(res.status, 201);
    assert.equal(res.json.user.role, 'root');
    assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(res.headers.get('set-cookie') ?? '', /SameSite=Strict/);
  });

  it('refuses a second setup and reports setup as complete', async () => {
    const again = await api('/api/auth/setup', { method: 'POST', body: { username: 'eindringling', password: 'anderes-passwort-1' } });
    assert.equal(again.status, 409);
    const status = await api('/api/auth/status');
    assert.equal(status.json.setupRequired, false);
  });

  it('returns an empty market and 404 for unknown stocks', async () => {
    const market = await api('/api/market');
    assert.equal(market.status, 200);
    assert.deepEqual(market.json.stocks, []);
    assert.equal((await api('/api/stocks/gibt-es-nicht')).status, 404);
  });
});

describe('login and roles', () => {
  /** @type {string} */
  let rootCookie = '';
  /** @type {string} */
  let adminCookie = '';
  /** @type {string} */
  let viewerCookie = '';
  /** @type {number} */
  let viewerId = 0;

  it('rejects a wrong password', async () => {
    const res = await api('/api/auth/login', { method: 'POST', body: { username: ROOT_NAME, password: 'falsch-falsch' } });
    assert.equal(res.status, 401);
  });

  it('logs the root account in', async () => {
    rootCookie = await login(ROOT_NAME, ROOT_PASSWORD);
    const status = await api('/api/auth/status', { headers: { Cookie: rootCookie } });
    assert.equal(status.json.user.role, 'root');
  });

  it('lets root create an admin and a viewer account', async () => {
    const admin = await api('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: rootCookie },
      body: { username: 'anna', role: 'admin', password: ADMIN_PASSWORD },
    });
    assert.equal(admin.status, 201);
    const viewer = await api('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: rootCookie },
      body: { username: 'lena', role: 'viewer', password: VIEWER_PASSWORD },
    });
    assert.equal(viewer.status, 201);
    viewerId = viewer.json.id;
  });

  it('rejects duplicate usernames (case-insensitive) and unknown roles', async () => {
    const dup = await api('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: rootCookie },
      body: { username: 'ANNA', role: 'viewer', password: VIEWER_PASSWORD },
    });
    assert.equal(dup.status, 409);
    const badRole = await api('/api/admin/users', {
      method: 'POST',
      headers: { Cookie: rootCookie },
      body: { username: 'peter', role: 'superuser', password: VIEWER_PASSWORD },
    });
    assert.equal(badRole.status, 400);
  });

  it('lists users for root only', async () => {
    const list = await api('/api/admin/users', { headers: { Cookie: rootCookie } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.users.map((/** @type {{ username: string }} */ u) => u.username).sort(), ['anna', 'lena', 'root']);
    adminCookie = await login('anna', ADMIN_PASSWORD);
    const denied = await api('/api/admin/users', { headers: { Cookie: adminCookie } });
    assert.equal(denied.status, 403);
  });

  it('lets an admin create stocks and milestones', async () => {
    const stock = await api('/api/admin/stocks', {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: { name: 'Mein Projekt', symbol: 'mp', startPrice: 50, listedAt: '2025-12-01T00:00:00.000Z' },
    });
    assert.equal(stock.status, 201);
    const event = await api('/api/admin/events', {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: { stockId: stock.json.id, title: 'Version 1.0', delta: 20.5, occursAt: '2026-01-01T09:00:00.000Z' },
    });
    assert.equal(event.status, 201);
    assert.equal((await api('/api/stocks/mein-projekt')).json.stock.price, 70.5);
  });

  it('gives a viewer read access but blocks every write', async () => {
    viewerCookie = await login('lena', VIEWER_PASSWORD);
    const market = await api('/api/market', { headers: { Cookie: viewerCookie } });
    assert.equal(market.status, 200);
    const write = await api('/api/admin/stocks', {
      method: 'POST',
      headers: { Cookie: viewerCookie },
      body: { name: 'Nein', symbol: 'NN' },
    });
    assert.equal(write.status, 403);
    const denyEvent = await api('/api/admin/events', {
      method: 'POST',
      headers: { Cookie: viewerCookie },
      body: { stockId: 1, title: 'Nein', delta: 5 },
    });
    assert.equal(denyEvent.status, 403);
  });

  it('applies role changes immediately: demoting an admin to viewer removes write access', async () => {
    const adminId = (await api('/api/admin/users', { headers: { Cookie: rootCookie } })).json.users.find(
      (/** @type {{ username: string, id: number }} */ u) => u.username === 'anna',
    ).id;
    const change = await api(`/api/admin/users/${adminId}`, { method: 'PUT', headers: { Cookie: rootCookie }, body: { role: 'viewer' } });
    assert.equal(change.status, 200);
    const write = await api('/api/admin/stocks', {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: { name: 'Später', symbol: 'SP' },
    });
    assert.equal(write.status, 403);
  });

  it('blocks cross-origin writes even with a valid root session', async () => {
    const res = await api('/api/admin/stocks', {
      method: 'POST',
      headers: { Cookie: rootCookie, Origin: 'https://evil.example' },
      body: { name: 'Böse', symbol: 'EVIL' },
    });
    assert.equal(res.status, 403);
  });

  it('requires a JSON content type for writes', async () => {
    const res = await api('/api/admin/stocks', { method: 'POST', headers: { Cookie: rootCookie, 'Content-Type': 'text/plain' } });
    assert.equal(res.status, 415);
  });

  it('lets root delete a viewer account, but not itself', async () => {
    const self = (await api('/api/auth/status', { headers: { Cookie: rootCookie } })).json.user.id;
    const selfDelete = await api(`/api/admin/users/${self}`, { method: 'DELETE', headers: { Cookie: rootCookie } });
    assert.equal(selfDelete.status, 400);
    const del = await api(`/api/admin/users/${viewerId}`, { method: 'DELETE', headers: { Cookie: rootCookie } });
    assert.equal(del.status, 200);
    assert.equal((await api('/api/auth/status', { headers: { Cookie: viewerCookie } })).json.user, null);
  });

  it('keeps at least one root account', async () => {
    const rootId = (await api('/api/auth/status', { headers: { Cookie: rootCookie } })).json.user.id;
    const demote = await api(`/api/admin/users/${rootId}`, { method: 'PUT', headers: { Cookie: rootCookie }, body: { role: 'admin' } });
    assert.equal(demote.status, 400);
  });

  it('lets a user change their own password and ends the session', async () => {
    const wrong = await api('/api/auth/password', {
      method: 'POST',
      headers: { Cookie: rootCookie },
      body: { currentPassword: 'falsch-falsch', newPassword: 'neues-passwort-99' },
    });
    assert.equal(wrong.status, 401);
    const ok = await api('/api/auth/password', {
      method: 'POST',
      headers: { Cookie: rootCookie },
      body: { currentPassword: ROOT_PASSWORD, newPassword: 'neues-passwort-99' },
    });
    assert.equal(ok.status, 200);
    assert.equal((await api('/api/auth/status', { headers: { Cookie: rootCookie } })).json.user, null);
    rootCookie = await login(ROOT_NAME, 'neues-passwort-99');
  });

  it('logs out and invalidates the session', async () => {
    const out = await api('/api/auth/logout', { method: 'POST', headers: { Cookie: adminCookie }, body: {} });
    assert.equal(out.status, 200);
    assert.equal((await api('/api/auth/status', { headers: { Cookie: adminCookie } })).json.user, null);
  });

  it('expires sessions after 12 hours', async () => {
    const cookie = await login(ROOT_NAME, 'neues-passwort-99');
    clock.now = new Date(START_CLOCK.getTime() + 13 * 60 * 60 * 1000);
    try {
      assert.equal((await api('/api/auth/status', { headers: { Cookie: cookie } })).json.user, null);
    } finally {
      clock.now = START_CLOCK;
    }
  });

  it('rate-limits repeated failed logins', async () => {
    /** @type {number[]} */
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await api('/api/auth/login', { method: 'POST', body: { username: ROOT_NAME, password: 'nope-nope-nope' } })).status);
    }
    assert.equal(statuses[statuses.length - 1], 429);
  });
});
