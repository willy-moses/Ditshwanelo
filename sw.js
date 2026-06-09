const CACHE = 'ditshwanelo-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/reset-password.html',
  '/manifest.json',
  '/styles.css',
  '/app.js',
  '/logo.js',
  '/icon-192.png',
  '/icon-512.png',
  '/sw.js',

  /* CDN scripts — cached on first install */
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      /* addAll fails if ANY request fails — use individual adds so
         one broken CDN doesn't kill the whole install */
      return Promise.allSettled(
        ASSETS.map(url => cache.add(url).catch(err => {
          console.warn('SW: failed to cache', url, err);
        }))
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  /* delete old caches so stale v1 assets don't linger */
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  /* skip non-GET and browser-extension requests */
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith('http')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      /* not in cache — try network, then cache the response for next t
      ime */
      return fetch(e.request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return response;
      }).catch(() => {
        /* offline and not cached — return the main page as fallback */
        if (e.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});