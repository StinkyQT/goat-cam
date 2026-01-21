// sw.js (DISABLED CACHING BUILD)
// This SW intentionally does NOT cache app assets.
// It exists only to avoid older cached SW taking control.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Clear any old caches
    if ("caches" in self) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

// Network-first (no cache)
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
