/* Service worker — offline support for localinvoice.
   Safe-by-design caching (relies on the app's content-hash cache-busting):
   - Navigations / HTML  -> network-first  (always picks up new deploys; cache = offline fallback)
   - Hashed assets (?v=) -> cache-first     (the URL changes when content changes, so never stale)
   - Other same-origin   -> stale-while-revalidate (instant load, refreshes in the background)
   - Cross-origin (RevenueCat / Stripe) -> NOT intercepted, always straight to the network
*/
const CACHE = "localinvoice-offline-v1";

self.addEventListener("install", (event) => {
  // Precache the shell HTML AND its own same-origin dependencies (scripts, styles,
  // libs, icons) parsed from index.html — so the app both loads AND runs offline
  // without throwing (e.g. its PDF/resume libraries are present). Lazy/worker/WASM
  // resources aren't listed here; they cache at runtime after first online use.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try { await cache.addAll(["/", "/index.html"]); } catch (e) {}
    try {
      const html = await (await fetch("/index.html", { cache: "no-cache" })).text();
      const urls = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g))
        .map((m) => m[1])
        .filter((u) => u && !u.includes("://") && !u.startsWith("//") && !u.startsWith("data:") && !u.startsWith("mailto:") && !u.startsWith("#"));
      await Promise.allSettled(urls.map((u) => cache.add(u).catch(() => {})));
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) { if (key !== CACHE) await caches.delete(key); }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // never touch Stripe / RevenueCat

  const isDoc = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isDoc) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match("/")) || (await caches.match("/index.html")) || Response.error();
      }
    })());
    return;
  }

  if (url.search.includes("v=")) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const fresh = await fetch(req);
      if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || network;
  })());
});
