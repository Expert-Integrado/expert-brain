// Expert Brain — service worker minimalista.
// Estratégia conservadora: stale-while-revalidate em assets estáticos
// (js/css/png/woff2/manifest), network-first em HTML, e NUNCA toca em endpoints
// de auth, MCP ou dados (graph/data, graph/meta, notes/*, api-keys). Sem precache
// agressivo — cache cresce orgânico conforme o usuário navega.

const VERSION = 'v1';
const CACHE = `brain-${VERSION}`;
const ASSET_RE = /\.(js|css|png|svg|webmanifest|woff2?)$/;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never touch auth, MCP, mutation or data endpoints — always go to network.
  if (
    url.pathname.startsWith('/authorize') ||
    url.pathname.startsWith('/token') ||
    url.pathname.startsWith('/register') ||
    url.pathname.startsWith('/mcp') ||
    url.pathname.startsWith('/app/graph/data') ||
    url.pathname.startsWith('/app/graph/meta') ||
    url.pathname.startsWith('/app/graph/link') ||
    url.pathname.startsWith('/app/login') ||
    url.pathname.startsWith('/app/logout') ||
    url.pathname.startsWith('/app/api-keys/')
  ) {
    return;
  }

  if (ASSET_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (url.pathname.startsWith('/app/')) {
    event.respondWith(networkFirst(req));
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(offlineHtml(), {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

function offlineHtml() {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · Expert Brain</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070a13;color:#f8fafc;font:15px -apple-system,system-ui,sans-serif;padding:24px}
.card{max-width:340px;text-align:center}
h1{font-size:22px;margin:0 0 12px;font-weight:500;letter-spacing:-0.015em}
p{color:rgba(248,250,252,0.58);line-height:1.55;margin:0 0 18px}
button{padding:10px 18px;background:rgba(167,139,250,0.18);color:#c4b5fd;border:1px solid rgba(167,139,250,0.4);border-radius:8px;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:rgba(167,139,250,0.28)}
</style></head><body><div class="card">
<h1>Sem conexão</h1>
<p>O Expert Brain precisa de internet pra carregar essa página. Tenta de novo quando voltar online.</p>
<button onclick="location.reload()">Tentar de novo</button>
</div></body></html>`;
}
