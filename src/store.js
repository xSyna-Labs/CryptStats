// @ts-check
import { ApiError } from './validate.js';
import {
  buildSeries,
  changeSince,
  roundPrice,
  DAY_MS,
  historyStats,
  sampleValues,
} from './pricing.js';
import { execute, many, one } from './db.js';

/** @typedef {import('./types.js').D1Database} D1Database */
/** @typedef {import('./pricing.js').Point} Point */

/**
 * @typedef {object} StockRow
 * @property {number} id
 * @property {string} slug
 * @property {string} symbol
 * @property {string} name
 * @property {string} description
 * @property {string} url
 * @property {number | null} parent_id
 * @property {number} start_price
 * @property {number} current_price
 * @property {string} listed_at
 * @property {string} created_at
 */

/**
 * @typedef {object} EventRow
 * @property {number} id
 * @property {number} stock_id
 * @property {string} title
 * @property {string} description
 * @property {number} delta
 * @property {string} occurs_at
 * @property {'scheduled' | 'applied'} status
 * @property {number | null} price_after
 * @property {string} created_at
 */

/**
 * @template T
 * @param {Record<string, unknown> | null} row
 * @returns {T | null}
 */
function cast(row) {
  return /** @type {T | null} */ (/** @type {unknown} */ (row));
}

/**
 * @template T
 * @param {Record<string, unknown>[]} rows
 * @returns {T[]}
 */
function castAll(rows) {
  return /** @type {T[]} */ (/** @type {unknown} */ (rows));
}

/** @param {D1Database} db @param {number} id */
async function findStock(db, id) {
  return cast(await one(db, 'SELECT * FROM stocks WHERE id = ?', id));
}

/** @param {D1Database} db @param {number} id */
async function requireStock(db, id) {
  const stock = await findStock(db, id);
  if (!stock) throw new ApiError(404, 'Aktie nicht gefunden');
  return stock;
}

/** @param {D1Database} db @param {number} id */
async function requireEvent(db, id) {
  const event = cast(await one(db, 'SELECT * FROM events WHERE id = ?', id));
  if (!event) throw new ApiError(404, 'Ereignis nicht gefunden');
  return event;
}

/**
 * Berechnet Kurs und Kursverlauf einer Aktie aus Startkurs und allen angewendeten Ereignissen neu.
 * Die Schreibvorgänge laufen als D1-Batch, damit sie gemeinsam gelten.
 * @param {D1Database} db
 * @param {number} stockId
 */
export async function recalculateStock(db, stockId) {
  const stock = await findStock(db, stockId);
  if (!stock) return;
  const applied = castAll(
    await many(
      db,
      `SELECT id, delta FROM events WHERE stock_id = ? AND status = 'applied' ORDER BY occurs_at, id`,
      stockId,
    ),
  );

  const statements = [
    db
      .prepare(`UPDATE events SET price_after = NULL WHERE stock_id = ? AND status = 'scheduled'`)
      .bind(stockId),
  ];
  let price = stock.start_price;
  for (const event of applied) {
    price = roundPrice(price + event.delta);
    statements.push(db.prepare('UPDATE events SET price_after = ? WHERE id = ?').bind(price, event.id));
  }
  statements.push(db.prepare('UPDATE stocks SET current_price = ? WHERE id = ?').bind(price, stockId));
  await db.batch(statements);
}

/**
 * Wendet alle fälligen geplanten Ereignisse an und berechnet die betroffenen Kurse neu.
 * @param {D1Database} db
 * @param {Date} [now]
 * @returns {Promise<number>} Anzahl der betroffenen Aktien
 */
export async function applyDueEvents(db, now = new Date()) {
  const iso = now.toISOString();
  const due = castAll(
    await many(
      db,
      `SELECT DISTINCT stock_id FROM events WHERE status = 'scheduled' AND occurs_at <= ?`,
      iso,
    ),
  );
  if (due.length === 0) return 0;
  await execute(
    db,
    `UPDATE events SET status = 'applied' WHERE status = 'scheduled' AND occurs_at <= ?`,
    iso,
  );
  for (const row of due) await recalculateStock(db, row.stock_id);
  return due.length;
}

/**
 * @param {D1Database} db
 * @param {string} base
 */
async function uniqueSlug(db, base) {
  let slug = base;
  let n = 2;
  while ((await one(db, 'SELECT id FROM stocks WHERE slug = ?', slug)) !== null) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

/** @param {string} name */
export function slugify(name) {
  return name
    .replace(/ä/gi, 'ae')
    .replace(/ö/gi, 'oe')
    .replace(/ü/gi, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * @param {D1Database} db
 * @param {string} symbol
 * @param {number} exceptId
 */
async function ensureSymbolFree(db, symbol, exceptId) {
  const taken = await many(db, 'SELECT id FROM stocks WHERE symbol = ? AND id != ?', symbol, exceptId);
  if (taken.length > 0) throw new ApiError(409, 'Dieses Kürzel ist bereits vergeben');
}

/** @param {D1Database} db @param {number | null} parentId */
async function ensureParentExists(db, parentId) {
  if (parentId !== null) await requireStock(db, parentId);
}

/**
 * @param {D1Database} db
 * @param {ReturnType<import('./validate.js').validateStockInput>} input
 * @param {Date} now
 * @returns {Promise<number>}
 */
export async function createStock(db, input, now) {
  await ensureSymbolFree(db, input.symbol, -1);
  await ensureParentExists(db, input.parentId);
  const slug = await uniqueSlug(db, slugify(input.name) || input.symbol.toLowerCase());
  const result = await execute(
    db,
    `INSERT INTO stocks (slug, symbol, name, description, url, parent_id, start_price, current_price, listed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slug,
    input.symbol,
    input.name,
    input.description,
    input.url,
    input.parentId,
    input.startPrice,
    input.startPrice,
    input.listedAt,
    now.toISOString(),
  );
  return Number(result.meta.last_row_id);
}

/**
 * Änderbar sind Name, Kürzel, Beschreibung, Link und übergeordnetes Projekt.
 * Startkurs und Notierungsdatum bleiben nach dem Anlegen unverändert.
 * @param {D1Database} db
 * @param {number} id
 * @param {ReturnType<import('./validate.js').validateStockInput>} input
 */
export async function updateStock(db, id, input) {
  await requireStock(db, id);
  await ensureSymbolFree(db, input.symbol, id);
  await ensureParentExists(db, input.parentId);
  // Zyklen verhindern: Das neue Elternprojekt darf nicht das Projekt selbst oder eines seiner Unterprojekte sein.
  let cursor = input.parentId;
  while (cursor !== null) {
    if (cursor === id) {
      throw new ApiError(400, 'Ein Projekt kann nicht unter sich selbst oder einem Unterprojekt hängen');
    }
    cursor = (await findStock(db, cursor))?.parent_id ?? null;
  }
  await execute(
    db,
    'UPDATE stocks SET name = ?, symbol = ?, description = ?, url = ?, parent_id = ? WHERE id = ?',
    input.name,
    input.symbol,
    input.description,
    input.url,
    input.parentId,
    id,
  );
}

/**
 * @param {D1Database} db
 * @param {number} id
 */
export async function deleteStock(db, id) {
  await requireStock(db, id);
  const children = await many(db, 'SELECT id FROM stocks WHERE parent_id = ?', id);
  if (children.length > 0) {
    throw new ApiError(409, 'Bitte zuerst die Unterprojekte entfernen oder umhängen');
  }
  await execute(db, 'DELETE FROM stocks WHERE id = ?', id);
}

/**
 * @param {StockRow} stock
 * @param {string} occursAt
 */
function ensureEventDate(stock, occursAt) {
  if (Date.parse(occursAt) < Date.parse(stock.listed_at)) {
    throw new ApiError(400, 'Der Zeitpunkt liegt vor dem Notierungsdatum der Aktie');
  }
}

/**
 * @param {string} occursAt
 * @param {Date} now
 */
function statusFor(occursAt, now) {
  return Date.parse(occursAt) <= now.getTime() ? 'applied' : 'scheduled';
}

/**
 * @param {D1Database} db
 * @param {ReturnType<import('./validate.js').validateEventInput>} input
 * @param {Date} now
 * @returns {Promise<number>}
 */
export async function createEvent(db, input, now) {
  const stock = await requireStock(db, input.stockId);
  ensureEventDate(stock, input.occursAt);
  const result = await execute(
    db,
    `INSERT INTO events (stock_id, title, description, delta, occurs_at, status, price_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    stock.id,
    input.title,
    input.description,
    input.delta,
    input.occursAt,
    statusFor(input.occursAt, now),
    now.toISOString(),
  );
  await recalculateStock(db, stock.id);
  return Number(result.meta.last_row_id);
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @param {ReturnType<import('./validate.js').validateEventInput>} input
 * @param {Date} now
 */
export async function updateEvent(db, id, input, now) {
  const event = await requireEvent(db, id);
  const stock = await requireStock(db, event.stock_id);
  ensureEventDate(stock, input.occursAt);
  await execute(
    db,
    `UPDATE events SET title = ?, description = ?, delta = ?, occurs_at = ?, status = ? WHERE id = ?`,
    input.title,
    input.description,
    input.delta,
    input.occursAt,
    statusFor(input.occursAt, now),
    id,
  );
  await recalculateStock(db, stock.id);
}

/**
 * @param {D1Database} db
 * @param {number} id
 */
export async function deleteEvent(db, id) {
  const event = await requireEvent(db, id);
  await execute(db, 'DELETE FROM events WHERE id = ?', id);
  await recalculateStock(db, event.stock_id);
}

/**
 * Wendet ein geplantes Ereignis sofort an; der Zeitpunkt wird auf „jetzt“ gesetzt.
 * @param {D1Database} db
 * @param {number} id
 * @param {Date} now
 */
export async function applyEventNow(db, id, now) {
  const event = await requireEvent(db, id);
  if (event.status === 'applied') throw new ApiError(409, 'Das Ereignis ist bereits angewendet');
  await execute(db, `UPDATE events SET status = 'applied', occurs_at = ? WHERE id = ?`, now.toISOString(), id);
  await recalculateStock(db, event.stock_id);
}

/**
 * Lädt den Kursverlauf aller Aktien in einem Durchlauf.
 * @param {D1Database} db
 * @param {StockRow[]} stocks
 * @returns {Promise<Map<number, Point[]>>}
 */
async function loadPointsByStock(db, stocks) {
  const events = castAll(await many(db, `SELECT * FROM events WHERE status = 'applied' ORDER BY occurs_at, id`));
  /** @type {Map<number, EventRow[]>} */
  const byStock = new Map();
  for (const event of events) {
    const list = byStock.get(event.stock_id) ?? [];
    list.push(event);
    byStock.set(event.stock_id, list);
  }
  /** @type {Map<number, Point[]>} */
  const result = new Map();
  for (const stock of stocks) {
    /** @type {Point[]} */
    const points = [{ t: Date.parse(stock.listed_at), price: stock.start_price }];
    for (const event of byStock.get(stock.id) ?? []) {
      points.push({
        t: Date.parse(event.occurs_at),
        price: event.price_after ?? stock.start_price,
        event: { id: event.id, title: event.title, delta: event.delta },
      });
    }
    result.set(stock.id, points);
  }
  return result;
}

/**
 * @param {StockRow} stock
 * @param {Point[]} points
 * @param {number} nowMs
 */
function toSummary(stock, points, nowMs) {
  const price = stock.current_price;
  const change = changeSince(points, price, nowMs);
  const spark = buildSeries(points, price, nowMs - 7 * DAY_MS, nowMs).map((p) => p.price);
  return {
    id: stock.id,
    slug: stock.slug,
    symbol: stock.symbol,
    name: stock.name,
    description: stock.description,
    url: stock.url,
    parentId: stock.parent_id,
    price,
    startPrice: stock.start_price,
    listedAt: stock.listed_at,
    change24h: change.change,
    changePct24h: change.changePct,
    spark: sampleValues(spark, 60),
  };
}

/** @param {EventRow} event */
function toEventView(event) {
  return {
    id: event.id,
    stockId: event.stock_id,
    title: event.title,
    description: event.description,
    delta: event.delta,
    occursAt: event.occurs_at,
    status: event.status,
    priceAfter: event.price_after,
  };
}

/**
 * @param {D1Database} db
 * @param {Date} now
 */
export async function getMarket(db, now = new Date()) {
  const stocks = castAll(await many(db, 'SELECT * FROM stocks ORDER BY symbol'));
  const points = await loadPointsByStock(db, stocks);
  const nowMs = now.getTime();
  return {
    generatedAt: now.toISOString(),
    stocks: stocks.map((s) => toSummary(s, points.get(s.id) ?? [], nowMs)),
  };
}

/**
 * @param {D1Database} db
 * @param {string} slug
 * @param {Date} now
 */
export async function getStockDetail(db, slug, now = new Date()) {
  const stock = cast(await one(db, 'SELECT * FROM stocks WHERE slug = ?', slug));
  if (!stock) return null;
  const all = castAll(await many(db, 'SELECT * FROM stocks ORDER BY symbol'));
  const points = await loadPointsByStock(db, all);
  const nowMs = now.getTime();
  const own = points.get(stock.id) ?? [];
  const parent = stock.parent_id !== null ? all.find((s) => s.id === stock.parent_id) : undefined;
  const children = all.filter((s) => s.parent_id === stock.id);
  const events = castAll(
    await many(
      db,
      `SELECT * FROM events WHERE stock_id = ? AND status = 'applied' ORDER BY occurs_at DESC, id DESC LIMIT 200`,
      stock.id,
    ),
  );
  const scheduled = castAll(
    await many(
      db,
      `SELECT * FROM events WHERE stock_id = ? AND status = 'scheduled' ORDER BY occurs_at, id`,
      stock.id,
    ),
  );
  const summary = toSummary(stock, own, nowMs);
  return {
    stock: { ...summary, stats: historyStats(own, stock.current_price) },
    parent: parent ? toSummary(parent, points.get(parent.id) ?? [], nowMs) : null,
    children: children.map((c) => toSummary(c, points.get(c.id) ?? [], nowMs)),
    history: own.map((p) => ({
      t: new Date(p.t).toISOString(),
      price: p.price,
      event: p.event ?? null,
    })),
    events: events.map(toEventView),
    scheduled: scheduled.map(toEventView),
  };
}
