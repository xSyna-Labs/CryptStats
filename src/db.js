// @ts-check

/** @typedef {import('./types.js').D1Database} D1Database */
/** @typedef {Record<string, unknown>} Row */

/**
 * Dünne Helfer über der D1-API. Alle Zugriffe sind asynchron, weil D1 pro Anfrage
 * eine Netzwerk-/Storage-Grenze überschreitet.
 * @param {D1Database} db
 * @param {string} sql
 * @param {...unknown} params
 */
export async function one(db, sql, ...params) {
  return await db.prepare(sql).bind(...params).first();
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {...unknown} params
 * @returns {Promise<Row[]>}
 */
export async function many(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

/**
 * Führt eine Schreiboperation aus und liefert `last_row_id`/`changes`.
 * @param {D1Database} db
 * @param {string} sql
 * @param {...unknown} params
 */
export async function execute(db, sql, ...params) {
  return await db.prepare(sql).bind(...params).run();
}
