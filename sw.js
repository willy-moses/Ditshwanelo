// ═══════════════════════════════════════════
//  Ditshwanelo Service Worker
//  ONE place to bump the version on each deploy
// ═══════════════════════════════════════════
const VERSION = 'v5.1';
const CACHE   = 'ditshwanelo-' + VERSION;

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
];

const CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

// ── INSTALL ──────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {

      // Local assets — must all succeed
      await cache.addAll(ASSETS);

      // CDN assets — failures are non-fatal
      await Promise.allSettled(
        CDN_ASSETS.map(url =>
          fetch(url, { mode: 'cors' })
            .then(res => {
              if (res.ok) cache.put(url, res);
            })
            .catch(() => {
              console.warn('SW: could not cache CDN asset:', url);
            })
        )
      );

    }).then(() => {
      console.log('[SW] Install complete —', CACHE);
      self.skipWaiting();
    })
  );
});

// ── ACTIVATE ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    // 1. Delete all old caches
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      ))

      // 2. Take control of all open tabs immediately
      .then(() => self.clients.claim())

      // 3. Tell every open tab a new SW is in charge
      //    — the page decides whether to reload
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => {
        console.log('[SW] Activated — notifying', clients.length, 'client(s)');
        clients.forEach(client =>
          client.postMessage({ type: 'SW_UPDATED', version: VERSION })
        );
      })
  );
});

// ── FETCH ────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;

  // Ignore non-GET and non-HTTP(S)
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  // ── Supabase / Groq API calls ──
  // Always try the network; return a clean JSON error when offline
  // so the app can handle it gracefully instead of crashing
  if (
    request.url.includes('supabase.co') ||
    request.url.includes('groq.com') ||
    request.url.includes('api.anthropic.com')
  ) {
    e.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', message: 'No network connection.' }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );
    return;
  }

  // ── Everything else — Cache-first, network fallback ──
  e.respondWith(
    caches.match(request).then(cached => {

      // Serve from cache immediately if available
      if (cached) return cached;

      // Not in cache — try the network
      return fetch(request)
        .then(response => {
          // Don't cache bad responses or opaque cross-origin responses
          if (
            !response ||
            response.status !== 200 ||
            response.type === 'opaque'
          ) {
            return response;
          }

          // Cache the fresh response for next time
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          // Network failed and nothing in cache
          if (request.destination === 'document') {
            // Offline fallback page
            return caches.match('/index.html');
          }
          if (request.destination === 'script' || request.destination === 'style') {
            return new Response('/* offline */', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          // For everything else (images etc.) just fail silently
          return new Response(null, { status: 503 });
        });
    })
  );
});

// ── MESSAGE HANDLER ──────────────────────────
// Lets the page query the current SW version
self.addEventListener('message', e => {
  if (e.data?.type === 'GET_VERSION') {
    e.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});

// ── NOTIFICATION CLICK ───────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const caseId = event.notification.data?.caseId;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it and send a message to open the thread
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (caseId) client.postMessage({ type: 'OPEN_GUIDANCE', caseId });
          return;
        }
      }
      // No open tab — open a new one
      return clients.openWindow('/index.html' + (caseId ? '?guidance=' + caseId : ''));
    })
  );
});