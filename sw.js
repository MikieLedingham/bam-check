// Keeps the app itself (not food data) available with no signal.
// Stale-while-revalidate: open instantly from the cache, refresh it in the
// background so the next launch has any update.
const CACHE = 'bam-check-v2';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'lib/gtin.js',
  'lib/lookup.js',
  'lib/manual.js',
  'lib/score.js',
  'lib/scanner.js',
  'lib/store.js',
  'vendor/barcode-detector.js',
  'vendor/zxing_reader.wasm',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only our own files. Food-database calls always go to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || new Response('Offline', { status: 503 });
    }),
  );
});
