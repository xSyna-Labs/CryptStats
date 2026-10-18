// @ts-check
import { createApp } from './app.js';
import { applyDueEvents } from './store.js';

/** @typedef {import('./types.js').D1Database} D1Database */
/** @typedef {import('./types.js').AssetFetcher} AssetFetcher */
/** @typedef {{ DB: D1Database, ASSETS: AssetFetcher, COOKIE_SECURE?: string }} Env */

/** @type {WeakMap<Env, (request: Request) => Promise<Response>>} */
const apps = new WeakMap();

/** @param {Env} env */
function appFor(env) {
  let app = apps.get(env);
  if (!app) {
    app = createApp({
      db: env.DB,
      // Workers laufen immer über HTTPS; nur für lokale Tests abschaltbar.
      config: { cookieSecure: env.COOKIE_SECURE !== 'false' },
      assets: env.ASSETS,
    });
    apps.set(env, app);
  }
  return app;
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    return appFor(env)(request);
  },

  /**
   * Cron Trigger (jede Minute): wendet fällige Meilensteine an, auch ohne Seitenaufruf.
   * @param {{ scheduledTime: number }} controller
   * @param {Env} env
   * @param {{ waitUntil: (promise: Promise<unknown>) => void }} ctx
   */
  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime || Date.now());
    ctx.waitUntil(
      applyDueEvents(env.DB, now).catch((err) => {
        console.error('Scheduler-Fehler:', err);
      }),
    );
  },
};
