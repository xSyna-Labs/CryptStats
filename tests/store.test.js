import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteDatabase } from '../src/sqlite-d1.js';
import {
  applyDueEvents,
  applyEventNow,
  createEvent,
  createRoadmapItem,
  createStock,
  deleteStock,
  getMarket,
  getRoadmapOverview,
  getStockDetail,
  updateStock,
} from '../src/store.js';
import {
  ApiError,
  validateEventInput,
  validateRoadmapInput,
  validateStockInput,
} from '../src/validate.js';
import { changeSince, roundPrice, sampleValues } from '../src/pricing.js';

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
  it('rounds prices while preserving negative values', () => {
    assert.equal(roundPrice(-50.126), -50.13);
    assert.equal(roundPrice(12.345), 12.35);
  });

  it('computes percentage changes consistently when prices are negative', () => {
    const t0 = NOW.getTime();
    const points = [{ t: t0 - 2 * 24 * 3600_000, price: -100 }];
    assert.deepEqual(changeSince(points, -50, t0), { reference: -100, change: 50, changePct: 50 });
    assert.deepEqual(changeSince(points, 50, t0), { reference: -100, change: 150, changePct: 150 });
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
  it('accepts negative and zero start prices', () => {
    assert.equal(validateStockInput({ name: 'x', symbol: 'XX', startPrice: -12.34 }, NOW).startPrice, -12.34);
    assert.equal(validateStockInput({ name: 'x', symbol: 'YY', startPrice: 0 }, NOW).startPrice, 0);
  });

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
  it('stores a negative initial price in SQLite', async () => {
    const { db } = await setup();
    const stockId = await createStock(
      db,
      validateStockInput({ name: 'Negativprojekt', symbol: 'NEG', startPrice: -12.5, listedAt: LISTED.toISOString() }, LISTED),
      LISTED,
    );
    const market = await getMarket(db, NOW);
    assert.equal(market.stocks.find((stock) => stock.id === stockId)?.price, -12.5);
    assert.equal((await detailOf(db, 'negativprojekt', NOW)).stock.startPrice, -12.5);
  });

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

  it('allows the price to fall below zero and recover again', async () => {
    const { db, stockId } = await setup();
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'Totalschaden', delta: -150, occursAt: '2026-01-02T00:00:00.000Z' }, NOW),
      NOW,
    );
    await createEvent(
      db,
      validateEventInput({ stockId, title: 'Erholung', delta: 25, occursAt: '2026-01-03T00:00:00.000Z' }, NOW),
      NOW,
    );
    const detail = await detailOf(db, 'cryptstats-core', NOW);
    assert.equal(detail.stock.price, -25);
    assert.equal(detail.stock.stats.low, -50);
    assert.equal(detail.history[1]?.price, -50);
    assert.equal(detail.history[2]?.price, -25);
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

  it('keeps a separate RoadMap per stock', async () => {
    const { db, stockId } = await setup();
    const otherId = await createStock(
      db,
      validateStockInput({ name: 'Other Project', symbol: 'OTH', startPrice: 50, listedAt: LISTED.toISOString() }, LISTED),
      LISTED,
    );
    await createRoadmapItem(db, stockId, validateRoadmapInput({ title: 'Core v2', status: 'doing' }), NOW);
    await createRoadmapItem(db, otherId, validateRoadmapInput({ title: 'Erster Release', status: 'done' }), NOW);

    const core = await detailOf(db, 'cryptstats-core', NOW);
    const other = await detailOf(db, 'other-project', NOW);
    assert.deepEqual(core.roadmap.map((r) => [r.title, r.status]), [['Core v2', 'doing']]);
    assert.deepEqual(other.roadmap.map((r) => [r.title, r.status]), [['Erster Release', 'done']]);

    const overview = await getRoadmapOverview(db);
    assert.equal(overview.find((s) => s.symbol === 'OTH')?.items.length, 1);
    assert.equal(overview.find((s) => s.symbol === 'CSC')?.items.length, 1);
  });
});
