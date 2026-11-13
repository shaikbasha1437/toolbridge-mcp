/* ToolBridge MCP playground service worker: network-first with a versioned per-file cache, so updates show up
   on the next online load and the playground (built-in server, demo agent) still works offline. */
const VERSION = 'toolbridge-v2';
const FILES = ['./', './index.html', './styles.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './core/audit.js','./core/gateway.js','./core/injection.js','./core/mcp.js','./core/policy.js','./core/redact.js','./core/resources.js','./core/seed.js','./core/sqlguard.js','./core/store.js','./core/tools.js','./core/validate.js','./js/agent.js','./js/app.js','./js/connection.js','./js/llm.js','./js/planner.js','./js/ui.js','./server/snippets.js','./vendor/mcp/mcp-sdk.js','./vendor/sqljs/sql-wasm-browser.js','./vendor/sqljs/sql-wasm-browser.wasm'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => Promise.all(FILES.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => null)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('toolbridge-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  const key = url.origin + url.pathname;
  e.respondWith(fetch(req).then((res) => { if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); } return res; })
    .catch(() => caches.open(VERSION).then((c) => c.match(key).then((m) => m || (req.mode === 'navigate' ? c.match(new URL('./index.html', self.registration.scope).href) : undefined)).then((m) => m || new Response('Offline and not cached yet.', { status: 503, headers: { 'content-type': 'text/plain' } })))));
});
