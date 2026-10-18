import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  applyDueEvents,
  applyEventNow,
  createEvent,
  createStock,
  deleteStock,
  getMarket,
  getStockDetail,
  updateStock,
} from '../src/store.js';
import { ApiError, validateEventInput, validateStockInput } from '../src/validate.js';
import { changeSince, clampPrice, sampleValues } from '../src/pricing.js';

/** @typedef {import('node:sqlite').DatabaseSync} Db */

/** @param {string} iso */
const at = (iso) => new Date(iso);

// Die Aktie ist seit dem 1. Dezember 2025 notiert.
const LISTED = at('2025-12-01T00:00:00.000Z');
// Ein fester „Jetzt“-Zeitpunkt für alle Tests.
const NOW = at('2026-01-10T10:00:00.000Z');

/** @returns {{ db: Db, stockId: number }} */
function setup() {
  const db = openDatabase(':memory:');
  const input = validateStockInput({ name: 'CryptStats Core', symbol: 'csc', startPrice: 100, listedAt: LISTED.toISOString() }, LISTED);
  const stockId = createStock(db, input, LISTED);
  return { db, stockId };
}

/**
 * @param {Db} db
 * @param {string} slug
 * @param {Date} now
 */
function detailOf(db, slug, now) {
  const detail = getStockDetail(db, slug, now);
  assert.ok(detail, `Aktie ${slug} sollte existieren`);
  return detail;
}

describe('pricing rules', () => {
  it('clamps prices to a minimum of 0.01', () => {
    assert.equal(clampPrice(-50), 0.01);
    assert.equal(clampPrice(12.345), 12.35);
  });

  it('computes the 24h change against the price one day earlier', () => {
    const t0 = NOW.getTime();
    const points = [
      { t: t0 - 3 * 24 * 3600_000, price: 100 },
      { t: t0 - 2 * 3600_000, price: 120 },
    ];
    assert.deepEqual(changeSince(points, 120, t0), { reference: 100, change: 20, changePct: 20 });
  });

  it('samples long series but keeps both endpoints', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const sampled = sampleValues(values, 10);
    assert.equal(sampled.length, 10);
    assert.equal(sampled[0], 0);
    assert.equal(sampled[9], 999);
  });
});

describe('validation', () => {
  it('rejects a symbol with invalid characters', () => {
    assert.throws(() => validateStockInput({ name: 'x', symbol: 'A-B' }, NOW), ApiError);
  });

  it('rejects an event with delta 0', () => {
    assert.throws(() => validateEventInput({ stockId: 1, title: 't', delta: 0 }, NOW), /nicht 0/);
  });

  it('rejects non-http links', () => {
    assert.throws(() => validateStockInput({ name: 'x', symbol: 'XX', url: 'javascript:alert(1)' }, NOW), /http/);
  });
});

describe('milestones and prices', () => {
  it('applies a positive and a negative milestone to the price', () => {
    const { db, stockId } = setup();
    createEvent(db, validateEventInput({ stockId, title: 'Launch', delta: 25, occursAt: '2026-01-02T00:00:00.000Z' }, NOW), NOW);
    createEvent(db, validateEventInput({ stockId, title: 'Bug-Rückschlag', delta: -10, occursAt: '2026-01-03T00:00:00.000Z' }, NOW), NOW);
    const stock = detailOf(db, 'cryptstats-core', NOW).stock;
    assert.equal(stock.price, 115);
    assert.equal(stock.stats.milestoneCount, 2);
  });

  it('never drops the price below the minimum', () => {
    const { db, stockId } = setup();
    createEvent(db, validateEventInput({ stockId, title: 'Totalschaden', delta: -500, occursAt: '2026-01-02T00:00:00.000Z' }, NOW), NOW);
    assert.equal(detailOf(db, 'cryptstats-core', NOW).stock.price, 0.01);
  });

  it('keeps scheduled events out of the price until they are due', () => {
    const { db, stockId } = setup();
    const release = at('2026-02-01T10:00:00.000Z');
    createEvent(db, validateEventInput({ stockId, title: 'Release', delta: 40, occursAt: release.toISOString() }, NOW), NOW);

    const before = detailOf(db, 'cryptstats-core', NOW);
    assert.equal(before.stock.price, 100);
    assert.equal(before.scheduled.length, 1);

    assert.equal(applyDueEvents(db, at('2026-01-31T23:59:00.000Z')), 0);
    assert.equal(applyDueEvents(db, release), 1);
    const after = detailOf(db, 'cryptstats-core', release);
    assert.equal(after.stock.price, 140);
    assert.equal(after.scheduled.length, 0);
    assert.equal(after.events[0]?.priceAfter, 140);
  });

  it('recalculates the whole chain when a backdated milestone is inserted', () => {
    const { db, stockId } = setup();
    createEvent(db, validateEventInput({ stockId, title: 'A', delta: 10, occursAt: '2025-12-05T10:00:00.000Z' }, NOW), NOW);
    createEvent(db, validateEventInput({ stockId, title: 'B', delta: 10, occursAt: '2025-12-06T10:00:00.000Z' }, NOW), NOW);
    createEvent(db, validateEventInput({ stockId, title: 'C', delta: -5, occursAt: '2025-12-02T10:00:00.000Z' }, NOW), NOW);
    const priceByTitle = new Map(detailOf(db, 'cryptstats-core', NOW).events.map((e) => [e.title, e.priceAfter]));
    assert.equal(priceByTitle.get('C'), 95);
    assert.equal(priceByTitle.get('A'), 105);
    assert.equal(priceByTitle.get('B'), 115);
  });

  it('applies a scheduled event immediately on request and sets its time to now', () => {
    const { db, stockId } = setup();
    const id = createEvent(db, validateEventInput({ stockId, title: 'Früh', delta: 5, occursAt: '2026-03-01T10:00:00.000Z' }, NOW), NOW);
    applyEventNow(db, id, NOW);
    const detail = detailOf(db, 'cryptstats-core', NOW);
    assert.equal(detail.stock.price, 105);
    assert.equal(detail.scheduled.length, 0);
  });

  it('refuses milestones before the listing date', () => {
    const { db, stockId } = setup();
    assert.throws(
      () => createEvent(db, validateEventInput({ stockId, title: 'Zu früh', delta: 1, occursAt: '2025-11-30T00:00:00.000Z' }, NOW), NOW),
      /Notierungsdatum/,
    );
  });
});

describe('hierarchy and market view', () => {
  it('lists sub-projects and blocks deleting a parent that still has children', () => {
    const { db, stockId } = setup();
    createStock(db, validateStockInput({ name: 'Unterprojekt', symbol: 'SUB', parentId: stockId, listedAt: LISTED.toISOString() }, LISTED), LISTED);
    const detail = detailOf(db, 'cryptstats-core', NOW);
    assert.equal(detail.children.length, 1);
    assert.throws(() => deleteStock(db, stockId), /Unterprojekte/);
  });

  it('prevents cycles when re-parenting', () => {
    const { db, stockId } = setup();
    const childId = createStock(db, validateStockInput({ name: 'Kind', symbol: 'KID', parentId: stockId, listedAt: LISTED.toISOString() }, LISTED), LISTED);
    assert.throws(
      () => updateStock(db, stockId, validateStockInput({ name: 'Core', symbol: 'CSC', parentId: childId }, NOW)),
      /Unterprojekt/,
    );
  });

  it('builds the market list with sparklines and 24h changes', () => {
    const { db, stockId } = setup();
    createEvent(db, validateEventInput({ stockId, title: 'Heute', delta: 10, occursAt: new Date(NOW.getTime() - 1000).toISOString() }, NOW), NOW);
    const market = getMarket(db, NOW);
    assert.equal(market.stocks.length, 1);
    assert.equal(market.stocks[0]?.price, 110);
    assert.equal(market.stocks[0]?.change24h, 10);
    assert.ok((market.stocks[0]?.spark.length ?? 0) >= 2);
  });
});
