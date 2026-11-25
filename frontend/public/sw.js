const CACHE_VERSION = 8;
const CACHE_NAME = "imiel-v" + CACHE_VERSION;
// Cache dedie au compteur de badge (nombre de nouveaux mails depuis la
// derniere ouverture de l'app). Le SW peut etre tue entre deux pushs :
// on persiste le compteur via l'API Cache (pas de variable globale).
const BADGE_CACHE = "imiel-badge";
// Ancien nom (HaikoMail) : son compteur est repris une fois a l'activation.
const LEGACY_BADGE_CACHE = "haikomail-badge";
const BADGE_KEY = "/__badge-count";

async function readBadgeCount() {
  try {
    const cache = await caches.open(BADGE_CACHE);
    const res = await cache.match(BADGE_KEY);
    if (!res) return 0;
    const n = parseInt(await res.text(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeBadgeCount(count) {
  try {
    const cache = await caches.open(BADGE_CACHE);
    await cache.put(BADGE_KEY, new Response(String(count)));
  } catch {
    // best effort
  }
}

async function clearAppBadgeCount() {
  await writeBadgeCount(0);
  if ("clearAppBadge" in self.navigator) {
    try { await self.navigator.clearAppBadge(); } catch {}
  }
}
const STATIC_ASSETS = [
  "/",
  "/manifest.json",
];

// Install: pre-cache static assets, force activate immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Reprise du compteur de badge garde sous l'ancien nom (renommage iMiel).
async function migrateLegacyBadge() {
  try {
    if (!(await caches.has(LEGACY_BADGE_CACHE))) return;
    const old = await caches.open(LEGACY_BADGE_CACHE);
    const res = await old.match(BADGE_KEY);
    if (res && !(await (await caches.open(BADGE_CACHE)).match(BADGE_KEY))) {
      await writeBadgeCount(parseInt(await res.text(), 10) || 0);
    }
  } catch {
    // best effort
  }
}

// Activate: clean ALL old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    migrateLegacyBadge().then(() => caches.keys()).then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== BADGE_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for navigations (always serve /), cache-first for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only cache http/https requests (ignore chrome-extension://, etc.)
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (request.method !== "GET") return;

  // Skip API, worker, and translate proxy requests
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/worker/") || url.pathname.startsWith("/translate/") || url.pathname.startsWith("/_/")) return;

  // All navigations -> serve root "/" (hash routing handles the rest)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch("/")
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", clone));
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached || new Response("Offline", { status: 503 })))
    );
    return;
  }

  // Static assets: network-first with cache fallback (avoids serving stale JS chunks)
  if (
    request.destination === "style" ||
    request.destination === "script" ||
    request.destination === "image" ||
    request.destination === "font"
  ) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || new Response("", { status: 404 })))
    );
  }
});

// Listen for cache-clear messages from the app (self-healing)
self.addEventListener("message", (event) => {
  // App ouverte / revenue au premier plan : remise a zero du badge
  if (event.data && event.data.type === "CLEAR_BADGE") {
    event.waitUntil(clearAppBadgeCount());
    return;
  }
  if (event.data && event.data.type === "CLEAR_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(keys.map((key) => caches.delete(key)))
      ).then(() => {
        // Notify all clients to reload
        self.clients.matchAll({ type: "window" }).then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: "CACHE_CLEARED" });
          }
        });
      })
    );
  }
});

// Push notifications
self.addEventListener("push", (event) => {
  if (!event.data) return;

  const data = event.data.json();

  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/mail-192.png",
    // Badge Android : silhouette BLANCHE sur transparent (le systeme n'en lit
    // que la transparence ; une icone en couleur y devient un carre blanc).
    badge: data.badge || "/icons/badge-96.png?v=2",
    tag: data.tag || "imiel-notification",
    data: {
      url: data.url || "/#/mail/all",
    },
    actions: data.actions || [
      { action: "open", title: "Ouvrir" },
      { action: "dismiss", title: "Ignorer" },
    ],
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || "iMiel", options);

      // Badge d'app (PWA) : compte les NOUVEAUX MAILS recus depuis la
      // derniere ouverture (tag "new-email-*" pose par le worker ; les notifs
      // suivi/agenda/newsletter ne comptent pas). Pas d'increment si l'app
      // est visible au premier plan (l'utilisateur voit deja le mail).
      if ("setAppBadge" in self.navigator && typeof data.tag === "string" && data.tag.indexOf("new-email-") === 0) {
        const clients = await self.clients.matchAll({ type: "window" });
        const appVisible = clients.some((c) => c.visibilityState === "visible");
        if (!appVisible) {
          const count = (await readBadgeCount()) + 1;
          await writeBadgeCount(count);
          try { await self.navigator.setAppBadge(count); } catch {}
        }
      }
    })()
  );
});

// Notification click: open the message URL
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const targetUrl = event.notification.data?.url || "/#/mail/all";

  event.waitUntil(clearAppBadgeCount());
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        // App deja ouverte : on NE fait PAS client.navigate() (peu fiable dans
        // la WKWebView iOS PWA -> le changement de hash ne prend pas, l'app
        // reste sur l'ecran courant). On poste plutot un message a la page qui
        // applique le deep-link via location.hash (navigation in-app, fiable),
        // puis on ramene la fenetre au premier plan.
        existing.postMessage({ type: "NAVIGATE", url: targetUrl });
        if ("focus" in existing) return existing.focus();
        return undefined;
      }
      // App fermee : ouvrir directement sur le deep-link.
      return self.clients.openWindow(targetUrl);
    })
  );
});

// Background sync for drafts
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-drafts") {
    event.waitUntil(syncDrafts());
  }
});

async function syncDrafts() {
  try {
    const cache = await caches.open("imiel-drafts");
    const requests = await cache.keys();

    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) continue;

      const draft = await response.json();

      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });

      if (res.ok) {
        await cache.delete(request);
      }
    }
  } catch {
    // Sync will be retried by the browser
  }
}
