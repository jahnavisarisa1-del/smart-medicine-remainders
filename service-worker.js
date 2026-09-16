const CACHE_NAME = "smart-medicine-reminder-v2";
const APP_ASSETS = ["./", "./index.html", "./style.css", "./data.js", "./languagePhrases.js", "./notification-config.js", "./firebase-patient.js", "./firebase-config.js", "./script.js", "./manifest.json"];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS)));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET" || event.request.url.includes("/api/")) return;
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
