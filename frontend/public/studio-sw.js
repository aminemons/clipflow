const version = "clipflow-studio-v1";
const shell = ["/studio.html", "/studio.webmanifest", "/studio/icon.svg", "/studio/icon-192.png", "/studio/icon-512.png", "/studio/sample.webp", "/studio/sample.mp4", "/fonts/Outfit.ttf", "/fonts/Anton.ttf", "/fonts/NotoSansArabic.ttf"];
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(version);
    const response = await fetch("/studio.html", { cache: "reload" });
    if (!response.ok) throw new Error("Studio is unavailable.");
    const html = await response.clone().text();
    await cache.put("/studio.html", response);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
    await cache.addAll([...shell.slice(1), ...assets]);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("clipflow-studio-") && name !== version) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener("message", event => {
  if (event.data?.type !== "CACHE_STUDIO_ASSETS" || !Array.isArray(event.data.urls)) return;
  const paths = event.data.urls.filter(path => typeof path === "string" && /^\/assets\/[\w.-]+\.(js|css)$/.test(path)).slice(0, 30);
  event.waitUntil(caches.open(version).then(cache => cache.addAll(paths)).catch(() => undefined));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (event.request.mode === "navigate" && ["/", "/studio.html"].includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match("/studio.html")));
  } else if (!event.request.headers.has("range") && (shell.includes(url.pathname) || url.pathname.startsWith("/assets/"))) {
    event.respondWith((async () => {
      const cache = await caches.open(version);
      const existing = await cache.match(event.request);
      if (existing) return existing;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })());
  }
});
