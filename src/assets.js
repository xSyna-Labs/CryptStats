// @ts-check
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Diese Dateien wertet Cloudflare als Konfiguration aus und liefert sie nicht aus.
const META_FILES = new Set(['_headers', '_redirects']);

function notFound() {
  return new Response('Nicht gefunden', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Liefert statische Dateien aus einem Verzeichnis. Die Oberfläche entspricht dem
 * ASSETS-Binding von Cloudflare, damit der Worker und der Container dieselbe App nutzen.
 * @param {string} rootDir
 */
export function createAssetFetcher(rootDir) {
  const root = resolve(rootDir);
  return {
    /** @param {Request} request */
    async fetch(request) {
      const url = new URL(request.url);
      let relative;
      try {
        relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      } catch {
        return notFound();
      }
      if (META_FILES.has(relative)) return notFound();
      const file = resolve(root, relative);
      if (file !== root && !file.startsWith(root + sep)) return notFound();
      try {
        const data = await readFile(file);
        const ext = extname(file);
        /** @type {Record<string, string>} */
        const headers = {
          'Content-Type': MIME[/** @type {keyof typeof MIME} */ (ext)] ?? 'application/octet-stream',
        };
        // HTML nie cachen, Assets mit ?v=<Version> dürfen dauerhaft im Cache bleiben.
        if (ext === '.html') headers['Cache-Control'] = 'no-cache';
        else if (url.searchParams.has('v')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        else headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
        return new Response(data, { headers });
      } catch {
        return notFound();
      }
    },
  };
}
