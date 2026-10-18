// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {import('./types.js').D1PreparedStatement} D1PreparedStatement */
/** @typedef {import('./types.js').D1Result} D1Result */
/** @typedef {import('node:sqlite').SQLInputValue} SqlValue */

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

class SqliteStatement {
  /**
   * @param {DatabaseSync} raw
   * @param {string} sql
   * @param {SqlValue[]} [params]
   */
  constructor(raw, sql, params = []) {
    this.raw = raw;
    this.sql = sql;
    this.params = params;
  }

  /** @param {...unknown} params */
  bind(...params) {
    return new SqliteStatement(this.raw, this.sql, /** @type {SqlValue[]} */ (params));
  }

  async first() {
    return this.raw.prepare(this.sql).get(...this.params) ?? null;
  }

  async all() {
    const results = this.raw.prepare(this.sql).all(...this.params);
    return { results: /** @type {Record<string, unknown>[]} */ (results) };
  }

  async run() {
    return this.runSync();
  }

  /** @returns {D1Result} */
  runSync() {
    const info = this.raw.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: {
        last_row_id: Number(info.lastInsertRowid),
        changes: Number(info.changes),
      },
    };
  }
}

/**
 * SQLite-Adapter mit der D1-Oberfläche. So läuft derselbe Anwendungscode
 * auf Cloudflare (echtes D1) und im Container (lokale Datei).
 */
export class SqliteDatabase {
  /** @param {DatabaseSync} raw */
  constructor(raw) {
    this.raw = raw;
  }

  /** @param {string} sql */
  prepare(sql) {
    return new SqliteStatement(this.raw, sql);
  }

  /** @param {D1PreparedStatement[]} statements */
  async batch(statements) {
    const prepared = /** @type {SqliteStatement[]} */ (statements);
    this.raw.exec('BEGIN');
    try {
      const results = prepared.map((statement) => statement.runSync());
      this.raw.exec('COMMIT');
      return results;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** @param {string} sql */
  async exec(sql) {
    this.raw.exec(sql);
  }

  close() {
    this.raw.close();
  }
}

/**
 * Öffnet die Datenbank (Datei oder `:memory:`) und wendet alle Migrationen an.
 * Die Migrationen sind idempotent (`CREATE TABLE IF NOT EXISTS`).
 * @param {string} [path]
 * @param {string} [migrationsDir]
 * @returns {SqliteDatabase}
 */
export function openSqliteDatabase(path = ':memory:', migrationsDir = MIGRATIONS_DIR) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  return new SqliteDatabase(raw);
}
