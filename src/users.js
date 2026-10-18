// @ts-check
import { ApiError } from './validate.js';
import { hashPassword, verifyPassword } from './auth.js';
import { execute, many, one } from './db.js';

/** @typedef {import('./types.js').D1Database} D1Database */
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

/** @param {D1Database} db */
export async function countUsers(db) {
  const row = await one(db, 'SELECT COUNT(*) AS n FROM users');
  return Number(row?.n ?? 0);
}

/** @param {D1Database} db */
async function countRoots(db) {
  const row = await one(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'root'`);
  return Number(row?.n ?? 0);
}

/** @param {D1Database} db */
export async function listUsers(db) {
  const rows = await many(db, 'SELECT id, username, role, created_at FROM users ORDER BY username');
  return rows.map((row) => ({
    id: Number(row.id),
    username: String(row.username),
    role: /** @type {Role} */ (String(row.role)),
    createdAt: String(row.created_at),
  }));
}

/**
 * Legt ein Konto an. Mit `onlyIfEmpty` gelingt das nur, solange noch kein Konto existiert (Ersteinrichtung).
 * @param {D1Database} db
 * @param {{ username: unknown, password: unknown, role: unknown }} input
 * @param {{ onlyIfEmpty?: boolean, now?: Date }} [options]
 */
export async function createUser(db, input, options = {}) {
  const username = validateUsername(input.username);
  const password = validatePassword(input.password);
  const role = validateRole(input.role);
  const passwordHash = await hashPassword(password);
  const createdAt = (options.now ?? new Date()).toISOString();

  try {
    // Die Bedingung steckt im INSERT, damit zwei gleichzeitige Ersteinrichtungen nicht beide gewinnen.
    const result = options.onlyIfEmpty
      ? await execute(
          db,
          `INSERT INTO users (username, password_hash, role, created_at)
           SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
          username,
          passwordHash,
          role,
          createdAt,
        )
      : await execute(
          db,
          'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
          username,
          passwordHash,
          role,
          createdAt,
        );

    if (Number(result.meta.changes) === 0) {
      throw new ApiError(409, 'Die Ersteinrichtung ist bereits abgeschlossen');
    }
    return Number(result.meta.last_row_id);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (/UNIQUE/i.test(String(err))) {
      throw new ApiError(409, 'Dieser Benutzername ist bereits vergeben');
    }
    throw err;
  }
}

/**
 * Rolle und/oder Passwort eines Kontos ändern. Bei Passwortänderung enden alle Sessions des Kontos.
 * @param {D1Database} db
 * @param {number} id
 * @param {{ role?: unknown, password?: unknown }} input
 */
export async function updateUser(db, id, input) {
  const role = input.role === undefined ? undefined : validateRole(input.role);
  const passwordHash =
    input.password === undefined ? undefined : await hashPassword(validatePassword(input.password));

  const user = await one(db, 'SELECT id, role FROM users WHERE id = ?', id);
  if (!user) throw new ApiError(404, 'Benutzer nicht gefunden');
  if (role !== undefined && role !== 'root' && String(user.role) === 'root' && (await countRoots(db)) <= 1) {
    throw new ApiError(400, 'Es muss mindestens ein Root-Konto geben');
  }
  if (role !== undefined) {
    await execute(db, 'UPDATE users SET role = ? WHERE id = ?', role, id);
  }
  if (passwordHash !== undefined) {
    await execute(db, 'UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, id);
    await execute(db, 'DELETE FROM sessions WHERE user_id = ?', id);
  }
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @param {number} actorId
 */
export async function deleteUser(db, id, actorId) {
  if (id === actorId) throw new ApiError(400, 'Du kannst dein eigenes Konto nicht löschen');
  const user = await one(db, 'SELECT id, role FROM users WHERE id = ?', id);
  if (!user) throw new ApiError(404, 'Benutzer nicht gefunden');
  if (String(user.role) === 'root' && (await countRoots(db)) <= 1) {
    throw new ApiError(400, 'Es muss mindestens ein Root-Konto geben');
  }
  await execute(db, 'DELETE FROM users WHERE id = ?', id);
}

/**
 * Eigenes Passwort ändern. Dazu muss das aktuelle Passwort stimmen; alle Sessions enden.
 * @param {D1Database} db
 * @param {number} userId
 * @param {unknown} currentPassword
 * @param {unknown} newPassword
 */
export async function changeOwnPassword(db, userId, currentPassword, newPassword) {
  const row = await one(db, 'SELECT password_hash FROM users WHERE id = ?', userId);
  if (!row) throw new ApiError(404, 'Benutzer nicht gefunden');
  const ok = await verifyPassword(requireString(currentPassword), String(row.password_hash));
  if (!ok) throw new ApiError(401, 'Das aktuelle Passwort ist falsch');
  const passwordHash = await hashPassword(validatePassword(newPassword));
  await execute(db, 'UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, userId);
  await execute(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
}

/**
 * Sucht ein Konto für den Login und prüft das Passwort. Gibt `null` bei falschen Daten zurück.
 * @param {D1Database} db
 * @param {unknown} username
 * @param {unknown} password
 */
export async function authenticate(db, username, password) {
  const name = requireString(username).trim().toLowerCase();
  const row = await one(
    db,
    'SELECT id, username, role, password_hash FROM users WHERE username = ?',
    name,
  );
  if (!row) return null;
  const ok = await verifyPassword(requireString(password), String(row.password_hash));
  if (!ok) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    role: /** @type {Role} */ (String(row.role)),
  };
}
