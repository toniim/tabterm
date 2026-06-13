// TabTerm service worker.
//
// Purpose is narrow: a registered SW with a fetch handler is one of Chrome's
// requirements for the "Install app" prompt (alongside a manifest + a secure
// context). We deliberately DO NOT cache anything — TabTerm is a live app whose
// state lives server-side and flows over WebSockets; a stale cached SPA or asset
// would silently desync terminals and notes. So every request goes straight to
// the network. Offline support is intentionally out of scope.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  // Pure passthrough. Never touch WebSocket upgrades or non-GET requests.
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request));
});
