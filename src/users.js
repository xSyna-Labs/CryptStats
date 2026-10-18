// @ts-check
import { ApiError } from './validate.js';
import { hashPassword, verifyPassword } from './auth.js';
import { transaction } from './store.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./auth.js').Role} Role */

export const ROLES = ['root', 'admin', 'viewer'];
export const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 200;
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

/** @param {unknown} value @returns {string} */
function requireString(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value */
export function validateUsername(value) {
  const username = requireString(value).trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, 'Benutzername: 3 bis 32 Zeichen (Buchstaben, Ziffern, _ . -)');
  }
  return username;
}

/** @param {unknown} value */
export function validatePassword(value) {
  const password = requireString(value);
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ApiError(400, `Passwort: mindestens ${PASSWORD_MIN_LENGTH} Zeichen`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ApiError(400, `Passwort: höchstens ${PASSWORD_MAX_LENGTH} Zeichen`);
  }
  return password;
}

/** @param {unknown} value @returns {Role} */
export function validateRole(value) {
  const role = requireString(value);
  if (!ROLES.includes(role)) throw new ApiError(400, 'Rolle muss root, admin oder viewer sein');
  return /** @type {Role} */ (role);
}

/** @param {Db} db */
export function countUsers(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0);
}

/** @param {Db} db */
function countRoots(db) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'root'`).get()?.n ?? 0);
}

/** @param {Db} db */
export function listUsers(db) {
  return db
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY username')
    .all()
    .map((row) => ({
      id: Number(row.id),
      username: String(row.username),
      role: /** @type {Role} */ (String(row.role)),
      createdAt: String(row.created_at),
    }));
}

/**
 * Legt ein Konto an. Mit `onlyIfEmpty` gelingt das nur, solange noch kein Konto existiert (Ersteinrichtung).
 * @param {Db} db
 * @param {{ username: unknown, password: unknown, role: unknown }} input
 * @param {{ onlyIfEmpty?: boolean, now?: Date }} [options]
 */
export async function createUser(db, input, options = {}) {
  const username = validateUsername(input.username);
  const password = validatePassword(input.password);
  const role = validateRole(input.role);
  const passwordHash = await hashPassword(password);
  return transaction(db, () => {
    if (options.onlyIfEmpty && countUsers(db) > 0) {
      throw new ApiError(409, 'Die Ersteinrichtung ist bereits abgeschlossen');
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      throw new ApiError(409, 'Dieser Benutzername ist bereits vergeben');
    }
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, role, (options.now ?? new Date()).toISOString());
    return Number(info.lastInsertRowid);
  });
}

/**
 * Rolle und/oder Passwort eines Kontos ändern. Bei Passwortänderung enden alle Sessions des Kontos.
 * @param {Db} db
 * @param {number} id
 * @param {{ role?: unknown, password?: unknown }} input
 */
export async function updateUser(db, id, input) {
  const role = input.role === undefined ? undefined : validateRole(input.role);
  const passwordHash =
    input.password === undefined ? undefined : await hashPassword(validatePassword(input.password));
  transaction(db, () => {
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError(404, 'Benutzer nicht gefunden');
    if (role !== undefined && role !== 'root' && String(user.role) === 'root' && countRoots(db) <= 1) {
      throw new ApiError(400, 'Es muss mindestens ein Root-Konto geben');
    }
    if (role !== undefined) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (passwordHash !== undefined) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  });
}

/**
 * @param {Db} db
 * @param {number} id
 * @param {number} actorId
 */
export function deleteUser(db, id, actorId) {
  transaction(db, () => {
    if (id === actorId) throw new ApiError(400, 'Du kannst dein eigenes Konto nicht löschen');
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError(404, 'Benutzer nicht gefunden');
    if (String(user.role) === 'root' && countRoots(db) <= 1) {
      throw new ApiError(400, 'Es muss mindestens ein Root-Konto geben');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
}

/**
 * Eigenes Passwort ändern. Dazu muss das aktuelle Passwort stimmen; alle Sessions enden.
 * @param {Db} db
 * @param {number} userId
 * @param {unknown} currentPassword
 * @param {unknown} newPassword
 */
export async function changeOwnPassword(db, userId, currentPassword, newPassword) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!row) throw new ApiError(404, 'Benutzer nicht gefunden');
  const ok = await verifyPassword(requireString(currentPassword), String(row.password_hash));
  if (!ok) throw new ApiError(401, 'Das aktuelle Passwort ist falsch');
  const passwordHash = await hashPassword(validatePassword(newPassword));
  transaction(db, () => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  });
}

/**
 * Sucht ein Konto für den Login und prüft das Passwort. Gibt `null` bei falschen Daten zurück.
 * @param {Db} db
 * @param {unknown} username
 * @param {unknown} password
 */
export async function authenticate(db, username, password) {
  const name = requireString(username).trim().toLowerCase();
  const row = db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?').get(name);
  if (!row) return null;
  const ok = await verifyPassword(requireString(password), String(row.password_hash));
  if (!ok) return null;
  return { id: Number(row.id), username: String(row.username), role: /** @type {Role} */ (String(row.role)) };
}
