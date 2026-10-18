import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteDatabase } from '../src/sqlite-d1.js';
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

/** @typedef {ReturnType<typeof openSqliteDatabase>} TestDatabase */

/** @param {string} iso */
const at = (iso) => new Date(iso);

// Die Aktie ist seit dem 1. Dezember 2025 notiert.
const LISTED = at('2025-12-01T00:00:00.000Z');
// Ein fester „Jetzt“-Zeitpunkt für alle Tests.
const NOW = at('2026-01-10T10:00:00.000Z');

/** @returns {Promise<{ db: TestDatabase, stockId: number }>} */
async function setup() {
  const db = openSqliteDatabase(':memory:');
  const input = validateStockInput(
    { name: 'CryptStats Core', symbol: 'csc', startPrice: 100, listedAt: LISTED.toISOString() },
    LISTED,
  );
  const stockId = await createStock(db, input, LISTED);
  return { db, stockId };
}

/**
 * @param {TestDatabase} db
 * @param {string} slug
 * @param {Date} now
 */
async function detailOf(db, slug, now) {
  const detail = await getStockDetail(db, slug, now);
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
  it('applies a positive and a negative milestone to the price', async () => {
    const { db, stockId } = await setup();
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'Launch', delta: 25, occursAt: '2026-01-02T00:00:00.000Z' }, NOW),
      NOW,
    );
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'Bug-Rückschlag', delta: -10, occursAt: '2026-01-03T00:00:00.000Z' }, NOW),
      NOW,
    );
    const stock = (await detailOf(db, 'cryptstats-core', NOW)).stock;
    assert.equal(stock.price, 115);
    assert.equal(stock.stats.milestoneCount, 2);
  });

  it('never drops the price below the minimum', async () => {
    const { db, stockId } = await setup();
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'Totalschaden', delta: -500, occursAt: '2026-01-02T00:00:00.000Z' }, NOW),
      NOW,
    );
    assert.equal((await detailOf(db, 'cryptstats-core', NOW)).stock.price, 0.01);
  });

  it('keeps scheduled events out of the price until they are due', async () => {
    const { db, stockId } = await setup();
    const release = at('2026-02-01T10:00:00.000Z');
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'Release', delta: 40, occursAt: release.toISOString() }, NOW),
      NOW,
    );

    const before = await detailOf(db, 'cryptstats-core', NOW);
    assert.equal(before.stock.price, 100);
    assert.equal(before.scheduled.length, 1);

    assert.equal(await applyDueEvents(db, at('2026-01-31T23:59:00.000Z')), 0);
    assert.equal(await applyDueEvents(db, release), 1);
    const after = await detailOf(db, 'cryptstats-core', release);
    assert.equal(after.stock.price, 140);
    assert.equal(after.scheduled.length, 0);
    assert.equal(after.events[0]?.priceAfter, 140);
  });

  it('recalculates the whole chain when a backdated milestone is inserted', async () => {
    const { db, stockId } = await setup();
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'A', delta: 10, occursAt: '2025-12-05T10:00:00.000Z' }, NOW),
      NOW,
    );
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'B', delta: 10, occursAt: '2025-12-06T10:00:00.000Z' }, NOW),
      NOW,
    );
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'C', delta: -5, occursAt: '2025-12-02T10:00:00.000Z' }, NOW),
      NOW,
    );
    const priceByTitle = new Map(
      (await detailOf(db, 'cryptstats-core', NOW)).events.map((event) => [event.title, event.priceAfter]),
    );
    assert.equal(priceByTitle.get('C'), 95);
    assert.equal(priceByTitle.get('A'), 105);
    assert.equal(priceByTitle.get('B'), 115);
  });

  it('applies a scheduled event immediately on request and sets its time to now', async () => {
    const { db, stockId } = await setup();
    const id = await createEvent(
      db,
      validateEventInput({ stockId, title: 'Früh', delta: 5, occursAt: '2026-03-01T10:00:00.000Z' }, NOW),
      NOW,
    );
    await applyEventNow(db, id, NOW);
    const detail = await detailOf(db, 'cryptstats-core', NOW);
    assert.equal(detail.stock.price, 105);
    assert.equal(detail.scheduled.length, 0);
  });

  it('refuses milestones before the listing date', async () => {
    const { db, stockId } = await setup();
    await assert.rejects(
      createEvent(
        db,
        validateEventInput({ stockId, title: 'Zu früh', delta: 1, occursAt: '2025-11-30T00:00:00.000Z' }, NOW),
        NOW,
      ),
      /Notierungsdatum/,
    );
  });
});

describe('hierarchy and market view', () => {
  it('lists sub-projects and blocks deleting a parent that still has children', async () => {
    const { db, stockId } = await setup();
    await createStock(
      db,
      validateStockInput({ name: 'Unterprojekt', symbol: 'SUB', parentId: stockId, listedAt: LISTED.toISOString() }, LISTED),
      LISTED,
    );
    const detail = await detailOf(db, 'cryptstats-core', NOW);
    assert.equal(detail.children.length, 1);
    await assert.rejects(deleteStock(db, stockId), /Unterprojekte/);
  });

  it('prevents cycles when re-parenting', async () => {
    const { db, stockId } = await setup();
    const childId = await createStock(
      db,
      validateStockInput({ name: 'Kind', symbol: 'KID', parentId: stockId, listedAt: LISTED.toISOString() }, LISTED),
      LISTED,
    );
    await assert.rejects(
      updateStock(db, stockId, validateStockInput({ name: 'Core', symbol: 'CSC', parentId: childId }, NOW)),
      /Unterprojekt/,
    );
  });

  it('builds the market list with sparklines and 24h changes', async () => {
    const { db, stockId } = await setup();
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'Heute', delta: 10, occursAt: new Date(NOW.getTime() - 1000).toISOString() }, NOW),
      NOW,
    );
    const market = await getMarket(db, NOW);
    assert.equal(market.stocks.length, 1);
    assert.equal(market.stocks[0]?.price, 110);
    assert.equal(market.stocks[0]?.change24h, 10);
    assert.ok((market.stocks[0]?.spark.length ?? 0) >= 2);
  });
});
