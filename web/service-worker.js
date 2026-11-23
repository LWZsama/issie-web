// The Web build prepends the revision and [relative URL, integrity] pairs for its complete output.
const scope = self.registration.scope;
const cachePrefix = "issie-web:" + scope + ":";
const cacheName = cachePrefix + revision;
const resources = new Map(assets.map(([path, integrity]) => [new URL(path, scope).href, integrity]));

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const requests = Array.from(resources, ([url, integrity]) => new Request(url, { integrity, cache: "reload" }));
    // addAll commits the batch only if every response matches this build.
    try {
      await cache.addAll(requests);
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // The browser waits for the previous version's tabs to close before activating an update.
    for (const name of await caches.keys()) {
      if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  url.hash = "";
  const key = url.href === scope ? new URL("index.html", scope).href : url.href;
  if (!resources.has(key)) return;
  event.respondWith(caches.match(key, { cacheName }).then(hit => hit || fetch(event.request)));
});
