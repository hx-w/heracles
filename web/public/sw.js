const OFFLINE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f6f7f4">
<title>Heracles · 离线</title>
<style>
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif; color: #245d42; background: #f6f7f4; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { padding: 32px; text-align: center; }
h1 { margin: 0 0 24px; font-size: 28px; }
p { color: #58665d; font-size: 18px; margin: 0 0 28px; }
a { display: inline-block; padding: 12px 24px; background: #245d42; color: #ffffff; border-radius: 12px; text-decoration: none; }
a:focus-visible { outline: 3px solid #c3e88d; outline-offset: 4px; }
</style>
</head>
<body><main><h1>Heracles</h1><p>当前离线</p><a href="/">重新连接</a></main></body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// No CacheStorage: authenticated pages, assets, and API responses stay network-only.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname !== '/' || url.search) return;

  event.respondWith(fetch(request).catch(() => new Response(OFFLINE_PAGE, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })));
});
