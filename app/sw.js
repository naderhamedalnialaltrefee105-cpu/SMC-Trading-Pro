const CACHE_NAME = "smc-trading-pro-v1";

const STATIC_FILES = [
  "/app/",
  "/app/index.html",
  "/app/style.css",
  "/app/app.js",
  "/app/manifest.json"
];

// تثبيت التطبيق وحفظ ملفات الواجهة
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_FILES);
    })
  );

  self.skipWaiting();
});

// تفعيل النسخة الجديدة
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );

  self.clients.claim();
});

// ملفات الواجهة من الذاكرة، وبيانات السوق من الشبكة
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  // لا نحفظ أسعار السوق أو الإشارات القديمة
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // الملفات الثابتة
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        return cached || fetch(request);
      })
    );
  }
});
