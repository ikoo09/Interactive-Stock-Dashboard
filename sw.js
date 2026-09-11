// CryptoScan Pro service worker.
// Keeps the existing dashboard intact and injects isolated realtime + 1D analysis layers.
const REALTIME_SCRIPT = '/realtime.js?v=1';
const ANALYSIS_SCRIPT = '/analysis-engine.js?v=1';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: 'no-store' });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) return response;

      const html = await response.text();
      if (html.includes(REALTIME_SCRIPT) && html.includes(ANALYSIS_SCRIPT)) {
        return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
      }

      const injected = html.replace('</body>', `<script src="${ANALYSIS_SCRIPT}" defer></script><script src="${REALTIME_SCRIPT}" defer></script></body>`);
      return new Response(injected, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      return fetch(request);
    }
  })());
});
