const CACHE_NOMBRE = "personal-montana-v1";

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  self.clients.claim();
});

// Estrategia simple: intenta la red primero, y si no hay conexión
// usa lo último que haya en caché (si existe).
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE_NOMBRE).then((cache) => cache.put(e.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(e.request))
  );
});
