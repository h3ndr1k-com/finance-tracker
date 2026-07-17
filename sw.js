const CACHE = 'ledger-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
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
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
