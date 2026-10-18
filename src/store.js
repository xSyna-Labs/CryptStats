// @ts-check
import { ApiError } from './validate.js';
import {
  buildSeries,
  changeSince,
  clampPrice,
  DAY_MS,
  historyStats,
  sampleValues,
} from './pricing.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('node:sqlite').SQLInputValue} SqlValue */
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
 * @param {Db} db
 * @param {(() => T)} fn
 * @returns {T}
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @param {Db} db
 * @param {string} sql
 * @param {SqlValue[]} [params]
 */
function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

/** @param {Db} db @param {number} id */
function findStock(db, id) {
  return /** @type {StockRow | undefined} */ (
    db.prepare('SELECT * FROM stocks WHERE id = ?').get(id)
  );
}

/** @param {Db} db @param {number} id */
function requireStock(db, id) {
  const stock = findStock(db, id);
  if (!stock) throw new ApiError(404, 'Aktie nicht gefunden');
  return stock;
}

/** @param {Db} db @param {number} id */
function requireEvent(db, id) {
  const event = /** @type {EventRow | undefined} */ (
    db.prepare('SELECT * FROM events WHERE id = ?').get(id)
  );
  if (!event) throw new ApiError(404, 'Ereignis nicht gefunden');
  return event;
}

/**
 * Wendet alle fälligen geplanten Ereignisse an und berechnet die betroffenen Kurse neu.
 * @param {Db} db
 * @param {Date} [now]
 * @returns {number} Anzahl der betroffenen Aktien
 */
export function applyDueEvents(db, now = new Date()) {
  const iso = now.toISOString();
  return transaction(db, () => {
    const due = /** @type {{ stock_id: number }[]} */ (
      rows(
        db,
        `SELECT DISTINCT stock_id FROM events WHERE status = 'scheduled' AND occurs_at <= ?`,
        [iso],
      )
    );
    if (due.length === 0) return 0;
    db.prepare(`UPDATE events SET status = 'applied' WHERE status = 'scheduled' AND occurs_at <= ?`).run(
      iso,
    );
    for (const { stock_id } of due) recalculateStock(db, stock_id);
    return due.length;
  });
}

/**
 * Berechnet Kurs und Kursverlauf einer Aktie aus Startkurs und allen angewendeten Ereignissen neu.
 * Muss innerhalb einer Transaktion aufgerufen werden.
 * @param {Db} db
 * @param {number} stockId
 */
export function recalculateStock(db, stockId) {
  const stock = findStock(db, stockId);
  if (!stock) return;
  const applied = /** @type {{ id: number, delta: number }[]} */ (
    rows(
      db,
      `SELECT id, delta FROM events WHERE stock_id = ? AND status = 'applied' ORDER BY occurs_at, id`,
      [stockId],
    )
  );
  db.prepare(`UPDATE events SET price_after = NULL WHERE stock_id = ? AND status = 'scheduled'`).run(stockId);
  const update = db.prepare('UPDATE events SET price_after = ? WHERE id = ?');
  let price = stock.start_price;
  for (const event of applied) {
    price = clampPrice(price + event.delta);
    update.run(price, event.id);
  }
  db.prepare('UPDATE stocks SET current_price = ? WHERE id = ?').run(price, stockId);
}

/**
 * @param {Db} db
 * @param {string} base
 */
function uniqueSlug(db, base) {
  let slug = base;
  let n = 2;
  while (rows(db, 'SELECT id FROM stocks WHERE slug = ?', [slug]).length > 0) {
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
 * @param {Db} db
 * @param {string} symbol
 * @param {number} exceptId
 */
function ensureSymbolFree(db, symbol, exceptId) {
  const taken = rows(db, 'SELECT id FROM stocks WHERE symbol = ? AND id != ?', [symbol, exceptId]);
  if (taken.length > 0) throw new ApiError(409, 'Dieses Kürzel ist bereits vergeben');
}

/**
 * @param {Db} db
 * @param {number | null} parentId
 */
function ensureParentExists(db, parentId) {
  if (parentId !== null) requireStock(db, parentId);
}

/**
 * @param {Db} db
 * @param {ReturnType<import('./validate.js').validateStockInput>} input
 * @param {Date} now
 * @returns {number}
 */
export function createStock(db, input, now) {
  return transaction(db, () => {
    ensureSymbolFree(db, input.symbol, -1);
    ensureParentExists(db, input.parentId);
    const slug = uniqueSlug(db, slugify(input.name) || input.symbol.toLowerCase());
    const info = db
      .prepare(
        `INSERT INTO stocks (slug, symbol, name, description, url, parent_id, start_price, current_price, listed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    return Number(info.lastInsertRowid);
  });
}

/**
 * Änderbar sind Name, Kürzel, Beschreibung, Link und übergeordnetes Projekt.
 * Startkurs und Notierungsdatum bleiben nach dem Anlegen unverändert.
 * @param {Db} db
 * @param {number} id
 * @param {ReturnType<import('./validate.js').validateStockInput>} input
 */
export function updateStock(db, id, input) {
  transaction(db, () => {
    requireStock(db, id);
    ensureSymbolFree(db, input.symbol, id);
    ensureParentExists(db, input.parentId);
    // Zyklen verhindern: Das neue Elternprojekt darf nicht das Projekt selbst oder eines seiner Unterprojekte sein.
    let cursor = input.parentId;
    while (cursor !== null) {
      if (cursor === id) {
        throw new ApiError(400, 'Ein Projekt kann nicht unter sich selbst oder einem Unterprojekt hängen');
      }
      cursor = findStock(db, cursor)?.parent_id ?? null;
    }
    db.prepare(
      'UPDATE stocks SET name = ?, symbol = ?, description = ?, url = ?, parent_id = ? WHERE id = ?',
    ).run(input.name, input.symbol, input.description, input.url, input.parentId, id);
  });
}

/**
 * @param {Db} db
 * @param {number} id
 */
export function deleteStock(db, id) {
  transaction(db, () => {
    requireStock(db, id);
    const children = rows(db, 'SELECT id FROM stocks WHERE parent_id = ?', [id]);
    if (children.length > 0) {
      throw new ApiError(409, 'Bitte zuerst die Unterprojekte entfernen oder umhängen');
    }
    db.prepare('DELETE FROM stocks WHERE id = ?').run(id);
  });
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
 * @param {Db} db
 * @param {ReturnType<import('./validate.js').validateEventInput>} input
 * @param {Date} now
 * @returns {number}
 */
export function createEvent(db, input, now) {
  return transaction(db, () => {
    const stock = requireStock(db, input.stockId);
    ensureEventDate(stock, input.occursAt);
    const info = db
      .prepare(
        `INSERT INTO events (stock_id, title, description, delta, occurs_at, status, price_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        stock.id,
        input.title,
        input.description,
        input.delta,
        input.occursAt,
        statusFor(input.occursAt, now),
        now.toISOString(),
      );
    recalculateStock(db, stock.id);
    return Number(info.lastInsertRowid);
  });
}

/**
 * @param {Db} db
 * @param {number} id
 * @param {ReturnType<import('./validate.js').validateEventInput>} input
 * @param {Date} now
 */
export function updateEvent(db, id, input, now) {
  transaction(db, () => {
    const event = requireEvent(db, id);
    const stock = requireStock(db, event.stock_id);
    ensureEventDate(stock, input.occursAt);
    db.prepare(
      `UPDATE events SET title = ?, description = ?, delta = ?, occurs_at = ?, status = ? WHERE id = ?`,
    ).run(input.title, input.description, input.delta, input.occursAt, statusFor(input.occursAt, now), id);
    recalculateStock(db, stock.id);
  });
}

/**
 * @param {Db} db
 * @param {number} id
 */
export function deleteEvent(db, id) {
  transaction(db, () => {
    const event = requireEvent(db, id);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    recalculateStock(db, event.stock_id);
  });
}

/**
 * Wendet ein geplantes Ereignis sofort an; der Zeitpunkt wird auf „jetzt“ gesetzt.
 * @param {Db} db
 * @param {number} id
 * @param {Date} now
 */
export function applyEventNow(db, id, now) {
  transaction(db, () => {
    const event = requireEvent(db, id);
    if (event.status === 'applied') throw new ApiError(409, 'Das Ereignis ist bereits angewendet');
    db.prepare(`UPDATE events SET status = 'applied', occurs_at = ? WHERE id = ?`).run(now.toISOString(), id);
    recalculateStock(db, event.stock_id);
  });
}

/**
 * Lädt den Kursverlauf aller Aktien in einem Durchlauf.
 * @param {Db} db
 * @param {StockRow[]} stocks
 * @returns {Map<number, Point[]>}
 */
function loadPointsByStock(db, stocks) {
  const events = /** @type {EventRow[]} */ (
    rows(db, `SELECT * FROM events WHERE status = 'applied' ORDER BY occurs_at, id`)
  );
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
 * @param {Db} db
 * @param {Date} now
 */
export function getMarket(db, now = new Date()) {
  const stocks = /** @type {StockRow[]} */ (rows(db, 'SELECT * FROM stocks ORDER BY symbol'));
  const points = loadPointsByStock(db, stocks);
  const nowMs = now.getTime();
  return {
    generatedAt: now.toISOString(),
    stocks: stocks.map((s) => toSummary(s, points.get(s.id) ?? [], nowMs)),
  };
}

/**
 * @param {Db} db
 * @param {string} slug
 * @param {Date} now
 */
export function getStockDetail(db, slug, now = new Date()) {
  const stock = /** @type {StockRow | undefined} */ (
    db.prepare('SELECT * FROM stocks WHERE slug = ?').get(slug)
  );
  if (!stock) return null;
  const all = /** @type {StockRow[]} */ (rows(db, 'SELECT * FROM stocks ORDER BY symbol'));
  const points = loadPointsByStock(db, all);
  const nowMs = now.getTime();
  const own = points.get(stock.id) ?? [];
  const parent = stock.parent_id !== null ? all.find((s) => s.id === stock.parent_id) : undefined;
  const children = all.filter((s) => s.parent_id === stock.id);
  const events = /** @type {EventRow[]} */ (
    rows(
      db,
      `SELECT * FROM events WHERE stock_id = ? AND status = 'applied' ORDER BY occurs_at DESC, id DESC LIMIT 200`,
      [stock.id],
    )
  );
  const scheduled = /** @type {EventRow[]} */ (
    rows(
      db,
      `SELECT * FROM events WHERE stock_id = ? AND status = 'scheduled' ORDER BY occurs_at, id`,
      [stock.id],
    )
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

