// @ts-check
import { resolve } from 'node:path';

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host
 * @property {string} dbPath
 * @property {boolean} cookieSecure
 */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT muss eine Zahl zwischen 0 und 65535 sein');
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dbPath: resolve(env.DB_PATH ?? 'data/cryptstats.db'),
    cookieSecure: env.COOKIE_SECURE === 'true',
  };
}
