// 세폰모 품앗이 서비스 워커 — 앱 껍데기 저장(인터넷 느릴 때도 열림) + 알림 받기·누르기
const CACHE = "pumasi-1f13440fed";
const SHELL = ["./", "index.html", "app.js", "style.css", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/badge-96.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// 같은 주소의 화면 파일만: 먼저 인터넷에서 새로 받고, 안 되면 저장본(고친 화면이 바로 보이게)
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("index.html"))),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "세폰모 품앗이", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "세폰모 품앗이", {
      body: d.body || "",
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      data: { url: d.url || self.registration.scope, app: d.app || self.registration.scope },
    }),
  );
});

// 알림을 누르면: 카페 글이면 카페(앱이 깔려 있으면 카페 앱)로, 아니면 품앗이 앱으로
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { url, app } = e.notification.data || {};
  const target = url || self.registration.scope;
  e.waitUntil((async () => {
    if (target.startsWith(self.registration.scope)) {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const w = wins.find((c) => c.url.startsWith(self.registration.scope));
      if (w) {
        await w.focus();
        if ("navigate" in w) await w.navigate(target).catch(() => {});
        return;
      }
      return self.clients.openWindow(target);
    }
    const opened = await self.clients.openWindow(target).catch(() => null);
    if (!opened && app) await self.clients.openWindow(app).catch(() => {});
  })());
});
