// @ts-check
import { execute, one } from './db.js';

/** @typedef {import('./types.js').D1Database} D1Database */
/** @typedef {'root' | 'admin' | 'viewer'} Role */
/** @typedef {{ id: number, username: string, role: Role }} CurrentUser */

export const SESSION_COOKIE = 'cryptstats_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

/**
 * PBKDF2-SHA256 mit 100.000 Runden. Der Wert steht im Hash, damit spätere Erhöhungen
 * alte Passwörter nicht ungültig machen.
 */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const encoder = new TextEncoder();

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** @param {string} value */
function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
function bytesToBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {number} length */
function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Promise<Uint8Array>}
 */
async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = fromBase64(parts[2] ?? '');
  const expected = fromBase64(parts[3] ?? '');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await deriveKey(password, salt, iterations);
  return equalBytes(expected, actual);
}

/** @param {string} value */
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * @param {D1Database} db
 * @param {number} userId
 * @param {Date} now
 */
export async function createSession(db, userId, now) {
  const token = bytesToBase64Url(randomBytes(32));
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await execute(db, 'DELETE FROM sessions WHERE expires_at <= ?', now.toISOString());
  await execute(
    db,
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    await sha256Hex(token),
    userId,
    expiresAt,
  );
  return { token, expiresAt };
}

/**
 * Liefert den angemeldeten Benutzer. Die Rolle wird bei jeder Anfrage aus der Datenbank gelesen,
 * damit Rollenänderungen sofort wirken.
 * @param {D1Database} db
 * @param {string | undefined} token
 * @param {Date} now
 * @returns {Promise<CurrentUser | null>}
 */
export async function getSessionUser(db, token, now) {
  if (!token) return null;
  const row = await one(
    db,
    `SELECT u.id, u.username, u.role, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    await sha256Hex(token),
  );
  if (!row || String(row.expires_at) <= now.toISOString()) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    role: /** @type {Role} */ (String(row.role)),
  };
}

/**
 * @param {D1Database} db
 * @param {string | undefined} token
 */
export async function destroySession(db, token) {
  if (!token) return;
  await execute(db, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
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

/**
 * Begrenzt Fehlversuche beim Login pro Schlüssel (z. B. IP-Adresse).
 * Der Zähler lebt pro Worker-Isolate; das ist ein bewusster Kompromiss, um D1 nicht
 * mit einem Schreibvorgang pro Fehlversuch zu belasten.
 */
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
