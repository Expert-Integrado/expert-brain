// Expert Brain — service worker minimalista.
// Estratégia conservadora: stale-while-revalidate em assets estáticos
// (js/css/png/woff2/manifest), network-first em HTML, e NUNCA toca em endpoints
// de auth, MCP ou dados (graph/data, graph/meta, notes/*, api-keys). Sem precache
// agressivo — cache cresce orgânico conforme o usuário navega.

// v2: limpa o cache acumulado da era `?v=Date.now()` (cada load gerava uma URL
// nova e entulhava o cache). Agora os bundles usam ?v=<hash> estável.
// v3: manifest.webmanifest ganhou share_target/shortcuts (specs/50-console-v2/
// 68-pwa-instalavel.md) — bump invalida o cache antigo do manifest (stale-while-
// revalidate por extensão) pra que o SO recarregue os atalhos/share target.
// v4: share_target virou POST multipart (arquivo → inbox com anexo) + Web Push
// sem payload + App Badging. O bump recarrega o manifest novo no SO.
const VERSION = 'v4';
const CACHE = `brain-${VERSION}`;
// Cache separado pro handoff do share de arquivo (não entra na limpeza por versão:
// pode haver um share pendente atravessando um deploy).
const SHARE_CACHE = 'brain-share';
const SHARE_PENDING_URL = '/_share/pending';
const ASSET_RE = /\.(js|css|png|svg|webmanifest|woff2?)$/;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Web Share Target nível 2 (specs/50-console-v2/68) ──────────────────────────
// O POST de navegação do share sheet NÃO carrega o cookie SameSite=Lax — se fosse
// direto pro Worker, cairia sem sessão. O SW intercepta ANTES da rede: guarda o
// arquivo no Cache API e redireciona pro GET do inbox com os params de texto +
// share=file; lá o client (shell bundle) resgata o blob e sobe com a sessão.
async function handleShareTarget(event) {
  try {
    const form = await event.request.formData();
    const params = new URLSearchParams();
    for (const k of ['title', 'text', 'url']) {
      const v = form.get(k);
      if (typeof v === 'string' && v.trim()) params.set(k, v.trim());
    }
    const file = form.get('media');
    if (file && typeof file !== 'string' && file.size > 0) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARE_PENDING_URL, new Response(file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-share-filename': encodeURIComponent(file.name || ''),
        },
      }));
      params.set('share', 'file');
    }
    const qs = params.toString();
    return Response.redirect(new URL('/app/inbox' + (qs ? '?' + qs : ''), self.location.origin).href, 303);
  } catch (err) {
    return Response.redirect(new URL('/app/inbox', self.location.origin).href, 303);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === '/app/inbox/share') {
    event.respondWith(handleShareTarget(event));
    return;
  }

  if (req.method !== 'GET') return;
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

// ── Web Push sem payload (specs/50-console-v2/68) ──────────────────────────────
// O push chega VAZIO (só o "toque no ombro"); o conteúdo vem fresco de
// /app/push/pending, buscado AQUI com o cookie de sessão do dispositivo. Se a
// busca falhar (offline, sessão expirada), mostra um genérico — com
// userVisibleOnly:true, receber push e não notificar é violação de contrato.
async function showPendingNotification() {
  let title = 'Expert Brain';
  let body = 'Você tem pendências no Brain.';
  let badge = null;
  let targetUrl = '/app';
  try {
    const res = await fetch('/app/push/pending', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.title) title = data.title;
      if (data.body) body = data.body;
      if (typeof data.badge_count === 'number') badge = data.badge_count;
      if (data.url) targetUrl = data.url;
    }
  } catch (err) {
    // segue com o genérico
  }
  if (badge !== null && 'setAppBadge' in self.navigator) {
    try {
      if (badge > 0) await self.navigator.setAppBadge(badge);
      else await self.navigator.clearAppBadge();
    } catch (err) { /* badging é opcional */ }
  }
  await self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'brain-digest',
    data: { url: targetUrl },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(showPendingNotification());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('/app') && 'focus' in c) {
          if ('navigate' in c) c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

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
