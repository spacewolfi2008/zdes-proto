// Офлайн-копия прототипа: все файлы кладутся в кеш при первом открытии.
const CACHE = 'zdes-proto-f404d2121c';
const FILES = [
 "./",
 "icon-180.png",
 "icon-192.png",
 "icon-512.png",
 "icon-maskable-512.png",
 "icon.svg",
 "index.html",
 "lib-devicekey.js",
 "lib-idb.js",
 "lib-keys.js",
 "lib-proto.js",
 "lib-qr.js",
 "lib-qrcode.js",
 "lib-qrmatrix.js",
 "lib-scanner.js",
 "lib-station-core.js",
 "lib-zxing-reader.js",
 "lib-zxing-share.js",
 "manifest.webmanifest",
 "proto.css",
 "proto.js",
 "zxing_reader.wasm"
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('zdes-proto-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request))),
  );
});
