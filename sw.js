/* Workout tracker cache. Network first, so a home-screen update shows
   the next time the phone is online. The old copy is only for offline opens. */
const CACHE = "wt-plan-2026-11-22";
self.addEventListener("install", event => { self.skipWaiting(); });
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(event.request))
  );
});
