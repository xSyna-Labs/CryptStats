import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createAssetFetcher } from '../src/assets.js';
import { openSqliteDatabase } from '../src/sqlite-d1.js';
import { VERSION } from '../src/version.js';

const ORIGIN = 'https://cryptstats.test';
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/** @param {string} relative */
const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('versioning', () => {
  it('keeps package.json, version.js and the asset URLs in sync', async () => {
    const pkg = JSON.parse(await read('../package.json'));
    assert.equal(pkg.version, VERSION, 'package.json und src/version.js müssen gleich sein');

    const html = await read('../public/index.html');
    assert.match(html, new RegExp(`/style\\.css\\?v=${VERSION.replace(/\./g, '\\.')}`));
    assert.match(html, new RegExp(`/app\\.js\\?v=${VERSION.replace(/\./g, '\\.')}`));
    assert.match(html, new RegExp(`/logo\\.svg\\?v=${VERSION.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(html, /(?:style\.css|app\.js)(?!\?v=)/, 'Assets brauchen ?v=<Version>');

    // Cloudflare liefert Assets vor dem Worker aus; der Header kommt dort aus _headers.
    const headers = await read('../public/_headers');
    assert.match(headers, new RegExp(`X-CryptStats-Version: ${VERSION.replace(/\./g, '\\.')}`));
  });

  it('serves the version over the API, in the header and with cache headers', async () => {
    const db = openSqliteDatabase(':memory:');
    const app = createApp({
      db,
      config: { cookieSecure: false },
      assets: createAssetFetcher(PUBLIC_DIR),
    });
    try {
      const version = await app(new Request(`${ORIGIN}/api/version`));
      assert.equal(version.status, 200);
      assert.deepEqual(await version.json(), { version: VERSION });
      assert.equal(version.headers.get('x-cryptstats-version'), VERSION);

      const page = await app(new Request(`${ORIGIN}/`));
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('x-cryptstats-version'), VERSION);
      assert.match(page.headers.get('cache-control') ?? '', /no-cache/);

      const js = await app(new Request(`${ORIGIN}/app.js?v=${VERSION}`));
      assert.equal(js.status, 200);
      assert.match(js.headers.get('cache-control') ?? '', /immutable/);

      const css = await app(new Request(`${ORIGIN}/style.css?v=${VERSION}`));
      assert.equal(css.status, 200);
      assert.match(css.headers.get('cache-control') ?? '', /immutable/);

      const unversioned = await app(new Request(`${ORIGIN}/app.js`));
      assert.doesNotMatch(unversioned.headers.get('cache-control') ?? '', /immutable/);
    } finally {
      db.close();
    }
  });

  it('calls the unit Punkte everywhere in the client', async () => {
    const source = await read('../public/app.js');
    assert.match(source, /const UNIT = 'Punkte';/);
    assert.doesNotMatch(source, /\bCoins\b/);
  });

  it('ships a PWA manifest with installable icons and a registered service worker', async () => {
    const manifest = JSON.parse(await read('../public/manifest.webmanifest'));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    /** @type {{ src: string, sizes: string }[]} */
    const icons = manifest.icons;
    const sizes = icons.map((icon) => icon.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'PNG-Icons 192 und 512 fehlen');
    for (const icon of icons) {
      const bytes = await readFile(fileURLToPath(new URL(`../public${icon.src}`, import.meta.url)));
      assert.ok(bytes.length > 0, `${icon.src} fehlt`);
    }

    const html = await read('../public/index.html');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest\?v=/);
    assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/logo-180\.png\?v=/);

    const app = await read('../public/app.js');
    assert.match(app, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
    const sw = await read('../public/sw.js');
    assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)\) return;/, 'API-Antworten dürfen nie gecacht werden');
  });

  it('serves the manifest with its MIME type and the RoadMap route is wired up', async () => {
    const db = openSqliteDatabase(':memory:');
    const app = createApp({
      db,
      config: { cookieSecure: false },
      assets: createAssetFetcher(PUBLIC_DIR),
    });
    try {
      const res = await app(new Request(`${ORIGIN}/manifest.webmanifest`));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
    } finally {
      db.close();
    }

    const source = await read('../public/app.js');
    assert.match(source, /parts\[0\] === 'roadmap'/);
    assert.match(source, /const ROADMAP_LABELS = \{/);
  });

  it('supports negative prices and colors negative chart values red', async () => {
    const source = await read('../public/app.js');
    assert.match(source, /let lo = Math\.min\(\.\.\.cs\.map\(\(c\) => c\.l\)\);[\s\S]*?lo -= pad;/);
    assert.match(source, /candle-down/);
    assert.match(source, /stock\.price < 0 \? 'down' : dirClass\(stock\.price - pts\[0\]\.price\)/);
    assert.match(source, /s\.price < 0 \? 'down' : dirClass\(s\.changePct24h\)/);
    assert.match(source, /min="-1000000000"/);
  });
});
