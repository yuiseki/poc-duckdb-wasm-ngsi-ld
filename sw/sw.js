// Service Worker: keeps the app shell, DuckDB-Wasm, its extensions and the ward
// outline in Cache Storage, so the page opens and queries without a network once it
// has been loaded. The data itself is in OPFS, not here.
//
// vite.config.ts fills in VERSION and PRECACHE at build time.
const VERSION = self.__VERSION__;
const PRECACHE = self.__PRECACHE__; // paths relative to this script
const SHELL = `shell-${VERSION}`;
const BASEMAP = 'basemap'; // tiles, style, sprites and glyphs seen while online
const BASEMAP_HOST = 'tile.yuiseki.net';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(PRECACHE.map((p) => new URL(p, self.location).href));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('shell-') && key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    // The page: network first so a new deploy shows up, the cached copy when offline.
    event.respondWith(
      fetch(req).catch(async () => (await caches.match(req, { ignoreSearch: true })) ?? caches.match(new URL('./', self.location).href)),
    );
    return;
  }
  if (url.origin === self.location.origin) {
    // Hashed assets and pinned extensions never change under the same URL.
    event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
    return;
  }
  if (url.host === BASEMAP_HOST) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(BASEMAP);
        try {
          const res = await fetch(req);
          if (res.ok) await cache.put(req, res.clone());
          return res;
        } catch (e) {
          const hit = await cache.match(req);
          if (hit) return hit;
          throw e;
        }
      })(),
    );
  }
});
