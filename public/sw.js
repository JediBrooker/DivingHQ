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
 *   - Vite-bundled hashed assets (/assets/*, which includes the
 *     bundled app CSS): CACHE-FIRST. URLs are content-hashed, so
 *     stale ones are never asked for again once the new
 *     index.html lands.
 *   - /api/* and /socket.io/*: never intercepted.
 *   - Every other same-origin GET (root /icon.svg,
 *     /manifest.webmanifest, /theme-init.js, guide screenshots,
 *     etc.): NETWORK-FIRST. These keep their filenames across
 *     deploys, so a cache-first entry would serve stale files
 *     forever. We update the cache copy on the way through so an
 *     offline visit still has something to serve.
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
// v7 → v8: the server used to answer a missing /assets chunk with the
// SPA shell (200, text/html) and we cached that under the .js URL,
// which left the screen blank on that device for good. Both ends are
// fixed now; the bump throws away any entry that was poisoned before.
const CACHE = "divinghq-shell-v8";

// Only HTML is allowed to become the offline shell, and HTML is never
// allowed into the /assets cache. A 200 isn't enough to go on: /metrics
// and /sitemap.xml are navigable too, and an old server build still
// hands out the shell for a chunk it doesn't have.
function isHtml(res) {
  return (res.headers.get("content-type") || "").includes("text/html");
}

// Hashed /assets names as Vite writes them, <name>-<8 char hash>.<ext>.
// A reference can look like "/assets/x", "assets/x" or "./x" depending on
// what's importing it, so match the file name and rebuild the path.
const ASSET_REF = /[\w.-]+-[\w-]{8}\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|avif|gif|ico)\b/g;
function assetRefs(text) {
  return [...new Set(text.match(ASSET_REF) || [])].map((f) => "/assets/" + f);
}

// Hashed assets never change, so nothing ever replaced them and every
// deploy's chunks piled up in the one cache (0.4-0.6 MB a deploy for a
// phone that uses the app a lot). When a fresh shell comes in, walk what
// it reaches (the shell names the entry and CSS, the entry names the lazy
// chunks, those name theirs) through what's cached, and drop the rest.
// That's everything from builds nobody is running any more. An open tab
// still on an old build that loses a chunk this way gets a 404 and
// reloads onto the new one (src/lib/staleChunk.js).
async function pruneAssets(html) {
  const cache = await caches.open(CACHE);
  const cached = new Map();
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (p.startsWith("/assets/")) cached.set(p, req);
  }
  const roots = assetRefs(html);
  // On the first load after a deploy the page is still fetching the new
  // entry, and without it we can't see which lazy chunks are still live.
  // Leave everything and let the next load do it.
  if (!roots.length || roots.some((p) => p.endsWith(".js") && !cached.has(p))) return;
  const keep = new Set();
  const queue = [...roots];
  while (queue.length) {
    const p = queue.pop();
    if (keep.has(p)) continue;
    keep.add(p);
    const req = cached.get(p);
    if (!req || !/\.(?:js|css)$/.test(p)) continue;
    const res = await cache.match(req);
    if (res) queue.push(...assetRefs(await res.text()));
  }
  await Promise.all(
    [...cached].filter(([p]) => !keep.has(p)).map(([, req]) => cache.delete(req)),
  );
}
// No "/" here: the offline navigation fallback only ever reads
// /index.html, so a cached "/" was a wasted request on install.
const SHELL = [
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
          if (res.ok && isHtml(res)) {
            const forCache = res.clone();
            const forPrune = res.clone();
            event.waitUntil(
              caches.open(CACHE)
                .then((c) => c.put("/index.html", forCache))
                .then(() => forPrune.text())
                .then(pruneAssets)
                .catch(() => {}),
            );
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
          if (res.status === 200 && !isHtml(res)) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(request, clone)).catch(() => {});
          }
          return res;
        });
      }),
    );
    return;
  }

  // Everything else same-origin (/icon.svg, /manifest.webmanifest,
  // /theme-init.js, guide screenshots, etc.): NETWORK-FIRST.
  // These keep stable filenames across deploys, so a cache-first
  // entry would serve stale content forever. Fall back to cache
  // only when the network is actually unreachable so the offline
  // shell still loads.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.status === 200) {
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
 * On notificationclick:
 *   - Approve / Deny on a referee sign-off answers it straight
 *     away and acks the row. If the server won't take the answer
 *     we open the request in the app instead.
 *   - Any other tap acks the row (a sign-off stays until it's
 *     answered), then routes an open SPA tab to action_url via
 *     postMessage, or opens a new window when there isn't one we
 *     can use. Broadcast/overlay windows are never taken over.
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

// A window we may take over for a notification. Broadcast and overlay
// screens (the projector, the OBS source) are left alone: yanking the
// live scoreboard to someone's inbox mid-meet would be worse than
// opening a second window.
function isChromeless(url) {
  return /[?&](overlay|broadcast)=/.test(url.search);
}

function ack(id) {
  if (!id) return Promise.resolve();
  return fetch(`/api/notifications/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => {});
}

// Approve / Deny on the referee sign-off notification answers the request
// right here, the same call the in-app banner makes. True only when the
// server recorded it; anything else (session expired, request gone or
// already answered) falls back to opening the app so the referee can see
// what happened and answer there.
async function answerSignoff(data, decision) {
  if (!data.event_id || !data.request_id) return false;
  try {
    const res = await fetch(
      `/api/events/${encodeURIComponent(data.event_id)}/dive-order/sign-off/respond`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: data.request_id, decision }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const { id, category } = data;
  const target = data.action_url || "/";
  const action = event.action;       // empty string when body tapped

  event.waitUntil((async () => {
    if (category === "referee_signoff" && (action === "approve" || action === "deny")) {
      if (await answerSignoff(data, action)) {
        await ack(id);
        return;
      }
    } else if (category !== "referee_signoff") {
      // Tapping it counts as reading it. A sign-off is different: it
      // stays in the inbox until it's actually answered.
      ack(id);
    }

    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const ours = all.filter((c) => {
      const u = new URL(c.url);
      return u.origin === self.location.origin && !isChromeless(u);
    });
    const client = ours.find((c) => c.focused)
      || ours.find((c) => c.visibilityState === "visible")
      || ours[0];
    if (client) {
      // The SPA routes itself to action_url (usePush), which keeps the
      // tab's state instead of reloading it.
      client.postMessage({ type: "notification-click", id, action, action_url: target });
      return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});
