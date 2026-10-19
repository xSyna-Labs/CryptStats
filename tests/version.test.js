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
});
