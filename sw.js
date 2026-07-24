const CACHE = 'ledger-v15';
const ASSETS = [
  './',
  './index.html',
  './sync.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/fonts/fraunces-normal-100-900.woff2',
  './vendor/fonts/fraunces-italic-100-900.woff2',
  './vendor/fonts/instrument-sans-normal-400-700.woff2',
  './vendor/fonts/instrument-sans-italic-400-700.woff2',
  './vendor/fonts/ibm-plex-mono-normal-400.woff2',
  './vendor/fonts/ibm-plex-mono-normal-500.woff2',
  './vendor/fonts/ibm-plex-mono-normal-600.woff2',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './vendor/tesseract-core-simd.wasm.js',
  './vendor/tesseract-core.wasm.js',
  './vendor/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract-core-lstm.wasm.js',
  './vendor/eng.traineddata.gz',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Never touch cross-origin traffic: the Dropbox API must not go through a
  // cache-first handler, and letting it fall through here turns an offline
  // request into a confusing TypeError instead of a clean network error.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
