// @ts-check
import { round2 } from './pricing.js';

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
export function asObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'Erwartet ein JSON-Objekt');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @param {{ label: string, max: number, required?: boolean }} opts
 */
function readText(body, key, { label, max, required = false }) {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (required) throw new ApiError(400, `${label} fehlt`);
    return '';
  }
  if (typeof raw !== 'string') throw new ApiError(400, `${label} muss Text sein`);
  const value = raw.trim();
  if (required && value === '') throw new ApiError(400, `${label} darf nicht leer sein`);
  if (value.length > max) throw new ApiError(400, `${label} darf höchstens ${max} Zeichen haben`);
  return value;
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @param {{ label: string, min: number, max: number }} opts
 */
function readNumber(body, key, { label, min, max }) {
  const raw = body[key];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(400, `${label} muss eine Zahl sein`);
  }
  if (value < min || value > max) {
    throw new ApiError(400, `${label} muss zwischen ${min} und ${max} liegen`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {string} ISO-Zeitstempel (UTC) */
export function parseDate(value, label) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new ApiError(400, `${label} ist kein gültiges Datum`);
  return new Date(ms).toISOString();
}

/** @param {string} value */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} input
 * @param {Date} now
 */
export function validateStockInput(input, now) {
  const body = asObject(input);
  const name = readText(body, 'name', { label: 'Name', max: 80, required: true });
  const symbol = readText(body, 'symbol', { label: 'Kürzel', max: 8, required: true }).toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(symbol)) {
    throw new ApiError(400, 'Kürzel: 2 bis 8 Buchstaben oder Ziffern (A–Z, 0–9)');
  }
  const description = readText(body, 'description', { label: 'Beschreibung', max: 2000 });
  const url = readText(body, 'url', { label: 'Link', max: 300 });
  if (url !== '' && !isHttpUrl(url)) {
    throw new ApiError(400, 'Link muss mit http:// oder https:// beginnen');
  }

  const rawParent = body.parentId;
  const parentId =
    rawParent === undefined || rawParent === null || rawParent === '' ? null : Number(rawParent);
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) {
    throw new ApiError(400, 'Ungültiges übergeordnetes Projekt');
  }

  const startPrice =
    body.startPrice === undefined || body.startPrice === ''
      ? 100
      : round2(readNumber(body, 'startPrice', { label: 'Startkurs', min: -1e9, max: 1e9 }));
  const listedAt =
    body.listedAt === undefined || body.listedAt === ''
      ? now.toISOString()
      : parseDate(body.listedAt, 'Notiert seit');

  return { name, symbol, description, url, parentId, startPrice, listedAt };
}

/**
 * @param {unknown} input
 * @param {Date} now
 */
export function validateEventInput(input, now) {
  const body = asObject(input);
  const stockId = Number(body.stockId);
  if (!Number.isInteger(stockId) || stockId <= 0) throw new ApiError(400, 'Aktie fehlt');

  const title = readText(body, 'title', { label: 'Titel', max: 120, required: true });
  const description = readText(body, 'description', { label: 'Beschreibung', max: 2000 });
  const delta = round2(readNumber(body, 'delta', { label: 'Wert (+/-)', min: -1e6, max: 1e6 }));
  if (delta === 0) throw new ApiError(400, 'Der Wert darf nicht 0 sein');
  const occursAt =
    body.occursAt === undefined || body.occursAt === ''
      ? now.toISOString()
      : parseDate(body.occursAt, 'Zeitpunkt');

  return { stockId, title, description, delta, occursAt };
}
