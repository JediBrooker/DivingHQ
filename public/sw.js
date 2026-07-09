/* DivingHQ service worker.
 *
 * Goal: a minimal offline shell so a judge's phone keeps the app
 * UI rendering when poolside wifi drops mid-meet. The actual
 * /api/* and /socket.io/* paths are NEVER served from cache:
 * those need to round-trip to the server, and a cached score
 * submission is worse than no submission.
 *
 * Strategy:
 *   - Navigation (the HTML shell): NETWORK-FIRST. We always try
 *     the live server, and only fall back to cached /index.html
 *     if the network actually fails. This means a fresh deploy
 *     reaches users immediately rather than being shadowed by
 *     a stale cache entry that points at vanished asset hashes.
 *   - Vite-bundled hashed assets (/assets/*): CACHE-FIRST. URLs
 *     are content-hashed, so stale ones are never asked for
 *     again once the new index.html lands.
 *   - Non-hashed static files (/css/app.css, /sw.js, root
 *     /icon.svg, /manifest.webmanifest, etc.): NETWORK-FIRST.
 *     These keep their filenames across deploys, so a cache-first
 *     entry would serve stale CSS/icons forever. We update the
 *     cache copy on the way through so an offline visit still
 *     has something to serve.
 *   - Anything else (API, sockets, PDFs): NETWORK ONLY.
 *
 * The cache name is versioned; bumping CACHE drops every prior
 * cached asset on activate. v3 = navigation switched from
 * cache-first to network-first to fix the "white page after
 * deploy" issue. v4 = non-hashed static files (/css/*, root
 * icons) switched from cache-first to network-first to fix the
 * "stale app.css" issue (panel CSS lifted to app.css wasn't
 * reaching browsers that had cached the previous app.css).
 */

// v5 → v6: new logo (Option C, arc + dot) replaced the old
// tucked-diver mark in /icon.svg + the 192/512 PNGs. The PNG
// filenames are unchanged, so without a cache-version bump
// returning PWA users would keep seeing the old icon from
// their shell cache until natural eviction.
// v6 → v7: i18n landed, swapping the bundle entry point and
// invalidating every previously-cached asset hash. Bumping the
// cache forces returning PWA users to re-fetch the shell on
// next visit instead of getting a blank page from stale hashes.
const CACHE = "divinghq-shell-v7";
const SHELL = [
  "/",
  "/index.html",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only, don't intercept third-party fonts, etc.
  if (url.origin !== self.location.origin) return;

  // Skip API + sockets entirely. These must never be cached.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/socket.io/")) return;

  // SPA navigation: NETWORK-FIRST. Critical for deploy hygiene,
  // a freshly-deployed index.html reaches users immediately
  // rather than being shadowed by a stale cache entry pointing
  // at vanished asset hashes. We update the cache copy in the
  // background so a future offline visit still has *something*
  // to serve.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put("/index.html", clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || Response.error())),
    );
    return;
  }

  // Vite-bundled hashed assets at /assets/*, content-hashed
  // URLs, so cache-first is safe and fastest.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          if (res.ok && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(request, clone)).catch(() => {});
          }
          return res;
        });
      }),
    );
    return;
  }

  // Everything else same-origin (/css/app.css, /sw.js,
  // /icon.svg, /manifest.webmanifest, etc.): NETWORK-FIRST.
  // These keep stable filenames across deploys, so a cache-first
  // entry would serve stale content forever. Fall back to cache
  // only when the network is actually unreachable so the offline
  // shell still loads.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error())),
  );
});

/* =============================================================
 * WEB PUSH HANDLERS
 *
 * The push backend (lib/push.js) sends an encrypted JSON payload
 * via the user's subscribed push service; this is where it lands.
 * Schema (kept in sync with sendNotification's wpPayload):
 *   {
 *     id,                  // notifications.id, used to ack on click
 *     category,            // 'referee_signoff', 'judge_call', ...
 *     title, body,
 *     data: {              // category-specific
 *       actions: [...] ?,  // optional Web Push action buttons
 *       ...,               // anything the SPA needs
 *     },
 *     action_url,          // SPA route to open on tap
 *   }
 *
 * On notificationclick we focus an existing SPA tab if one's
 * open (the in-app banner has likely already handled it), only
 * spinning up a new tab when no SPA window is around. Either
 * way we POST /api/notifications/:id/acknowledge so the inbox
 * row clears.
 * ============================================================= */

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "DivingHQ", body: event.data.text() };
  }
  const {
    id,
    title = "DivingHQ",
    body = "",
    data = {},
    action_url = "/",
    category,
  } = payload;

  const options = {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: id || category,         // collapse repeats of the same row
    renotify: true,
    requireInteraction: !!(data.actions && data.actions.length),
    data: { id, action_url, category, ...data },
    actions: Array.isArray(data.actions) ? data.actions : undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { id, action_url } = event.notification.data || {};
  const action = event.action;       // empty string when body tapped

  // Build the URL to open. Append ?notif=<id>&action=<approve|deny>
  // so the SPA knows which row to ack + (for action buttons) which
  // outcome to record.
  let target = action_url || "/";
  const sep = target.includes("?") ? "&" : "?";
  const params = [];
  if (id)     params.push(`notif=${encodeURIComponent(id)}`);
  if (action) params.push(`action=${encodeURIComponent(action)}`);
  if (params.length) target += sep + params.join("&");

  event.waitUntil((async () => {
    // Best-effort ack so a tapped notification clears from the
    // inbox even if the SPA never opens (offline, blocked popup,
    // etc.). The SPA also acks on render so this is belt+braces.
    if (id) {
      fetch(`/api/notifications/${encodeURIComponent(id)}/acknowledge`, {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => {});
    }
    const clientsList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    // Focus the first same-origin SPA tab + post a message so it
    // can react in-place rather than navigating away.
    for (const client of clientsList) {
      const url = new URL(client.url);
      if (url.origin === self.location.origin) {
        client.postMessage({ type: "notification-click", id, action, action_url: target });
        return client.focus();
      }
    }
    // No SPA tab open, fall back to opening the action URL.
    return self.clients.openWindow(target);
  })());
});
