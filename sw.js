// Uygulama kabuğunu ve Supabase kütüphanesini (CDN) önbelleğe alır; veriler her zaman Supabase'den canlı gelir.
const CACHE = 'butcemiz-v12';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png'];
const CDN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Önce ağ, olmazsa önbellek: güncellemeler hemen gelir, internet ya da CDN yoksa uygulama yine açılır.
// Ağ 4 sn içinde cevap vermezse önbellekteki sürüm kullanılır (yavaş bağlantıda beyaz ekran kalmasın).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || (url.origin !== location.origin && url.origin !== CDN)) return;
  const network = fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000)).then(() => caches.match(e.request));
  e.respondWith(
    Promise.race([network.catch(() => caches.match(e.request)), timeout.then((c) => c || network)])
      .then((r) => r || network),
  );
});
