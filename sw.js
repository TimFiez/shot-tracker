/* Shot Tracker — Service Worker v6
   Strategy:
   - App shell files (html/js/css): network-first with cache fallback
     → always gets latest code, falls back to cache when offline
   - External CDN assets: cache-first
     → icons font rarely changes, fast from cache
*/
const CACHE = 'shot-tracker-v9';
const CDN_CACHE = 'shot-tracker-cdn-v1';

const APP_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json'
];

const CDN_FILES = [
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/fonts/tabler-icons.woff2'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    Promise.all([
      caches.open(CACHE).then(function(cache) {
        return Promise.allSettled(APP_FILES.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('Failed to cache app file:', url, err);
          });
        }));
      }),
      caches.open(CDN_CACHE).then(function(cache) {
        return Promise.allSettled(CDN_FILES.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('Failed to cache CDN file:', url, err);
          });
        }));
      })
    ])
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) {
          return k !== CACHE && k !== CDN_CACHE;
        }).map(function(k) {
          console.log('Deleting old cache:', k);
          return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var url = e.request.url;

  /* CDN assets — cache first */
  if (url.includes('jsdelivr.net') || url.includes('tabler-icons')) {
    e.respondWith(
      caches.open(CDN_CACHE).then(function(cache) {
        return cache.match(e.request).then(function(cached) {
          if (cached) return cached;
          return fetch(e.request).then(function(response) {
            if (response && response.status === 200) cache.put(e.request, response.clone());
            return response;
          });
        });
      })
    );
    return;
  }

  /* App files — network first, cache fallback */
  e.respondWith(
    fetch(e.request).then(function(response) {
      if (response && response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
      }
      return response;
    }).catch(function() {
      /* Offline — serve from cache */
      return caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        /* Last resort for navigation requests */
        if (e.request.destination === 'document') return caches.match('/index.html');
      });
    })
  );
});
