const CACHE_NOMBRE = "personal-montana-v1";

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  self.clients.claim();
});

// Estrategia simple: intenta la red primero, y si no hay conexión
// usa lo último que haya en caché (si existe).
// IMPORTANTE: la caché del navegador solo admite peticiones GET — las
// peticiones POST (registrar, verificar PIN, etc.) nunca se deben tocar
// con cache.put(), o el navegador las rechaza con un error de red incluso
// cuando la conexión está perfecta. Por eso las dejamos pasar directo.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') {
    e.respondWith(fetch(e.request));
    return;
  }
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
