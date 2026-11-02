
"use strict";

const CACHE_NAME = "smc-trading-pro-v2";

const STATIC_FILES = [
  "/app/index.html",
  "/app/style.css",
  "/app/app.js",
  "/app/manifest.json",
  "/app/icon.png"
];

// تثبيت النسخة الجديدة
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_FILES))
  );

  self.skipWaiting();
});

// حذف النسخ القديمة
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

// تحديث الملفات من الخادم مع الاحتفاظ بنسخة احتياطية
self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // بيانات السوق والإشارات لا تؤخذ من الذاكرة
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) return cached;

        if (request.mode === "navigate") {
          const home = await caches.match("/app/index.html");
          if (home) return home;
        }

        return new Response("الملف غير متاح حالياً", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        });
      })
  );
});
