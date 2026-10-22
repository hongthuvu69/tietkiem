// Service worker: cho app mở được khi mất mạng.
// "Network-first": có mạng thì luôn lấy bản mới nhất (bỏ qua cache HTTP 10 phút của GitHub Pages),
// mạng chậm quá 3 giây hoặc mất mạng thì dùng bản đã lưu. Dữ liệu sổ không đi qua đây.
const CACHE = "tietkiem-v1";
const FONT_CACHE = "tietkiem-fonts"; // font Google: lưu lâu dài, không xóa khi đổi phiên bản
const TIMEOUT_MS = 3000;
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "js/app.js",
  "js/store.js",
  "js/sync.js",
  "js/report.js",
  "js/charts.js",
  "js/util.js",
  "js/config.js",
  "icons/icon-192.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: "no-cache" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE && key !== FONT_CACHE) await caches.delete(key);
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Font Google: lấy từ cache trước, chưa có thì tải rồi lưu lại.
  if (req.method === "GET" && /^https:\/\/fonts\.(googleapis|gstatic)\.com$/.test(url.origin)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONT_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") cache.put(req, res.clone());
        return res;
      })()
    );
    return;
  }
  // Chỉ cache file của chính app; request tới Supabase đi thẳng ra mạng.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const network = fetch(req, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      event.waitUntil(network);
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
      const fresh = await Promise.race([network, timeout]);
      if (fresh) return fresh;
      const cached = await cache.match(req, { ignoreSearch: true });
      return cached || (await network) || new Response("Offline", { status: 503 });
    })()
  );
});
