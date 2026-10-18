// @ts-check
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {'root' | 'admin' | 'viewer'} Role */
/** @typedef {{ id: number, username: string, role: Role }} CurrentUser */

export const SESSION_COOKIE = 'cryptstats_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const KEY_LENGTH = 64;

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
function deriveKey(password, salt, length) {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] ?? '', 'base64');
  const expected = Buffer.from(parts[2] ?? '', 'base64');
  if (expected.length === 0) return false;
  const actual = await deriveKey(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

/** @param {string} value */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {Db} db
 * @param {number} userId
 * @param {Date} now
 */
export function createSession(db, userId, now) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256Hex(token),
    userId,
    expiresAt,
  );
  return { token, expiresAt };
}

/**
 * Liefert den angemeldeten Benutzer. Die Rolle wird bei jeder Anfrage aus der Datenbank gelesen,
 * damit Rollenänderungen sofort wirken.
 * @param {Db} db
 * @param {string | undefined} token
 * @param {Date} now
 * @returns {CurrentUser | null}
 */
export function getSessionUser(db, token, now) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256Hex(token));
  if (!row || String(row.expires_at) <= now.toISOString()) return null;
  return { id: Number(row.id), username: String(row.username), role: /** @type {Role} */ (String(row.role)) };
}

/**
 * @param {Db} db
 * @param {string | undefined} token
 */
export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
}

/**
 * @param {string | undefined} header
 * @param {string} name
 */
export function getCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * @param {string} token
 * @param {string} expiresAt
 * @param {boolean} secure
 */
export function sessionCookie(token, expiresAt, secure) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** @param {boolean} secure */
export function clearSessionCookie(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** @param {Role} role */
export function canWrite(role) {
  return role === 'root' || role === 'admin';
}

/** Begrenzt Fehlversuche beim Login pro Schlüssel (z. B. IP-Adresse). */
export class LoginLimiter {
  /** @type {Map<string, { failures: number, resetAt: number }>} */
  #entries = new Map();

  /**
   * @param {string} key
   * @param {Date} now
   */
  isBlocked(key, now) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now.getTime()) {
      this.#entries.delete(key);
      return false;
    }
    return entry.failures >= LOGIN_MAX_FAILURES;
  }

  /**
   * @param {string} key
   * @param {Date} now
   */
  recordFailure(key, now) {
    const entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= now.getTime()) {
      this.#entries.set(key, { failures: 1, resetAt: now.getTime() + LOGIN_WINDOW_MS });
    } else {
      entry.failures += 1;
    }
  }

  /** @param {string} key */
  reset(key) {
    this.#entries.delete(key);
  }
}
