// @ts-check

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ id: number, title: string, delta: number }} PointEvent
 * @typedef {{ t: number, price: number, event?: PointEvent }} Point
 */

/** @param {number} n */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** @param {number} n */
export function roundPrice(n) {
  return round2(n);
}

/**
 * Kurs zu einem Zeitpunkt. `points` ist nach Zeit sortiert, der erste Punkt ist die Notierung.
 * @param {Point[]} points
 * @param {number} t
 */
export function priceAt(points, t) {
  let price = points[0]?.price ?? 0;
  for (const p of points) {
    if (p.t <= t) price = p.price;
    else break;
  }
  return price;
}

/**
 * Stufenförmige Kursreihe im Zeitraum [from, to]. Beginnt mit dem Kurs am Anfang des Zeitraums
 * und endet mit dem aktuellen Kurs.
 * @param {Point[]} points
 * @param {number} currentPrice
 * @param {number} from
 * @param {number} to
 * @returns {Point[]}
 */
export function buildSeries(points, currentPrice, from, to) {
  const out = [{ t: from, price: priceAt(points, from) }];
  for (const p of points) {
    if (p.t > from && p.t <= to) out.push(p);
  }
  out.push({ t: to, price: currentPrice });
  return out;
}

/**
 * Veränderung gegenüber dem Kurs vor 24 Stunden.
 * @param {Point[]} points
 * @param {number} currentPrice
 * @param {number} nowMs
 */
export function changeSince(points, currentPrice, nowMs) {
  const reference = priceAt(points, nowMs - DAY_MS);
  const change = round2(currentPrice - reference);
  const changePct = reference === 0 ? 0 : round2(((currentPrice - reference) / Math.abs(reference)) * 100);
  return { reference, change, changePct };
}

/**
 * @param {Point[]} points
 * @param {number} currentPrice
 */
export function historyStats(points, currentPrice) {
  const prices = points.map((p) => p.price);
  const start = points[0]?.price ?? currentPrice;
  return {
    high: round2(Math.max(...prices, currentPrice)),
    low: round2(Math.min(...prices, currentPrice)),
    performancePct: start === 0 ? 0 : round2(((currentPrice - start) / Math.abs(start)) * 100),
    milestoneCount: Math.max(0, points.length - 1),
  };
}

/**
 * Reduziert eine Werteliste auf höchstens `max` Stützstellen (inklusive Anfang und Ende).
 * @param {number[]} values
 * @param {number} max
 */
export function sampleValues(values, max) {
  if (values.length <= max) return values;
  const out = [];
  for (let i = 0; i < max; i++) {
    out.push(values[Math.round((i * (values.length - 1)) / (max - 1))] ?? 0);
  }
  return out;
}
