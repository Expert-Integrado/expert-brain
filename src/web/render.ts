import { esc } from '../util/html.js';
import { NEBULA_CSS, FONT_LINKS } from './styles.js';

export function renderShell(opts: {
  title: string;
  active: 'notes' | 'graph' | 'config' | 'api-keys';
  email: string;
  body: string;
  extraHead?: string;
}): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#070a13">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Brain">
<title>${esc(opts.title)} · Expert Brain</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/expert-integrado-logo.png">
<link rel="apple-touch-icon" href="/icon-192.png">
${FONT_LINKS}
<style>${NEBULA_CSS}</style>
${opts.extraHead ?? ''}
</head><body>
<div class="shell">
  <aside class="sidebar">
    <div class="logo">Expert Brain</div>
    <a class="nav-item${opts.active === 'graph' ? ' active' : ''}" href="/app/graph">Graph</a>
    <a class="nav-item${opts.active === 'notes' ? ' active' : ''}" href="/app/notes">Notes</a>
    <a class="nav-item${opts.active === 'config' ? ' active' : ''}" href="/app/config">Config</a>
    <a class="nav-item${opts.active === 'api-keys' ? ' active' : ''}" href="/app/api-keys">API Keys</a>
    <div class="bottom">
      <div>${esc(opts.email)}</div>
      <form method="post" action="/app/logout"><button type="submit">Log out</button></form>
    </div>
  </aside>
  <main class="main">${opts.body}</main>
</div>
<nav class="bottom-nav" role="navigation" aria-label="Navegação principal">
  <a class="bottom-nav-item${opts.active === 'graph' ? ' active' : ''}" href="/app/graph" aria-label="Graph">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8" y1="8" x2="11" y2="16"/><line x1="16" y1="8" x2="13" y2="16"/><line x1="9" y1="6" x2="15" y2="6"/></svg>
    <span>Graph</span>
  </a>
  <a class="bottom-nav-item${opts.active === 'notes' ? ' active' : ''}" href="/app/notes" aria-label="Notes">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
    <span>Notes</span>
  </a>
  <a class="bottom-nav-item${opts.active === 'config' ? ' active' : ''}" href="/app/config" aria-label="Config">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    <span>Config</span>
  </a>
  <a class="bottom-nav-item${opts.active === 'api-keys' ? ' active' : ''}" href="/app/api-keys" aria-label="API Keys">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
    <span>Keys</span>
  </a>
  <form class="bottom-nav-logout-form" method="post" action="/app/logout" role="none">
    <button class="bottom-nav-item bottom-nav-logout" type="submit" aria-label="Sair">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      <span>Sair</span>
    </button>
  </form>
</nav>
<script src="/app/shell/bundle.js" defer></script>
</body></html>`;
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Google Fonts is allow-listed for style-src and font-src so the Fraunces/Manrope
      // stylesheets and woff2 files load. Everything else stays 'self'-only.
      'content-security-policy':
        "default-src 'self'; " +
        "script-src 'self'; " +
        "worker-src 'self'; " +
        "manifest-src 'self'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data:; " +
        "connect-src 'self'",
    },
  });
}
