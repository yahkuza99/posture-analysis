/* Service worker: keeps a copy of the app so it opens and works with no internet.
 * VERSION is stamped with the commit on deploy; a new version installs in the background
 * and takes over when the user accepts the update prompt in the app. */
const VERSION = '__APP_VERSION__';
const CACHE = 'posture-' + VERSION;
const FILES = [
  './',
  'index.html',
  'css/style.css',
  'css/fonts.css',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.png',
  'fonts/sarabun-thai-400-normal.woff2',
  'fonts/sarabun-thai-500-normal.woff2',
  'fonts/sarabun-thai-600-normal.woff2',
  'fonts/sarabun-thai-700-normal.woff2',
  'fonts/sarabun-latin-400-normal.woff2',
  'fonts/sarabun-latin-500-normal.woff2',
  'fonts/sarabun-latin-600-normal.woff2',
  'fonts/sarabun-latin-700-normal.woff2',
  'fonts/montserrat-latin-500-normal.woff2',
  'fonts/montserrat-latin-600-normal.woff2',
  'fonts/montserrat-latin-700-normal.woff2',
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never stores stale files
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('posture-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ?v= stamps only bust the HTTP cache; the cached copy is keyed without them
    const hit = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    try { return await fetch(req); }
    catch { return new Response('ออฟไลน์อยู่ และไม่มีไฟล์นี้ในเครื่อง', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});
