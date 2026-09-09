importScripts('./reminders.js');

const CACHE = 'ledger-v27';
const ASSETS = [
  './',
  './index.html',
  './sync.js',
  './reminders.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
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

function isIconOrManifest(url) {
  return url.pathname.endsWith('/manifest.webmanifest')
    || url.pathname.includes('/icons/')
    || /apple-touch-icon/.test(url.pathname);
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Never touch cross-origin traffic: the Dropbox API must not go through a
  // cache-first handler, and letting it fall through here turns an offline
  // request into a confusing TypeError instead of a clean network error.
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // Icons + manifest: network-first so home-screen / PWA icon updates land.
  if (isIconOrManifest(url)) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => {
              cache.put(e.request, copy);
              // Also refresh the unversioned asset path used by ASSETS / offline.
              const clean = '.' + url.pathname;
              if (clean.startsWith('./icons/') || clean.endsWith('manifest.webmanifest')) {
                cache.put(clean, response.clone()).catch(() => {});
              }
            });
          }
          return response;
        })
        .catch(async () => {
          return (await caches.match(e.request))
            || (await caches.match('.' + url.pathname))
            || Response.error();
        })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fresh = fetch(e.request).then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(e.request, response.clone()));
        return response;
      });
      return hit || fresh;
    })
  );
});

let reminderState = { enabled: false, subs: [], sentLog: {} };

self.addEventListener('message', (e) => {
  if (e.data?.type === 'REMINDER_SYNC') reminderState = e.data.payload || reminderState;
  if (e.data?.type === 'REMINDER_CHECK') e.waitUntil(fireRecurringReminders(reminderState));
});

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'recurring-reminders') e.waitUntil(fireRecurringReminders(reminderState));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = './' + (e.notification.data?.view ? `?view=${e.notification.data.view}` : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) {
        client.postMessage({ type: 'OPEN_VIEW', view: e.notification.data?.view || 'subscriptions' });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

async function fireRecurringReminders(state) {
  if (!state?.enabled || !self.registration?.showNotification) return;
  const tomorrow = reminderTomorrowISO();
  const pending = pendingRecurringReminders(state.subs, tomorrow, state.sentLog);
  for (const sub of pending) {
    await self.registration.showNotification(`${sub.name} due tomorrow`, {
      body: reminderBody(sub, sub.date),
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: reminderKey(sub),
      renotify: true,
      data: { view: 'subscriptions', key: reminderKey(sub) },
    });
    state.sentLog[reminderKey(sub)] = reminderTodayISO();
  }
  if (pending.length) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'REMINDER_SENT', sentLog: state.sentLog });
  }
}
