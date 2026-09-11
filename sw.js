// CryptoScan Pro service worker cleanup.
// This replaces the previous third-party service worker and immediately
// unregisters itself so the site is no longer controlled by external code.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map(key => caches.delete(key)));

    const clientsList = await self.clients.matchAll({ type: 'window' });
    for (const client of clientsList) {
      client.navigate(client.url);
    }
  })());
});
