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
<button class="sidebar-reopen" type="button" aria-label="Abrir menu" aria-haspopup="menu" aria-expanded="false" aria-hidden="true">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
</button>
<div class="sidebar-menu" role="menu" aria-label="Navegação" hidden>
  <a class="sidebar-menu-item${opts.active === 'graph' ? ' active' : ''}" href="/app/graph" role="menuitem">Graph</a>
  <a class="sidebar-menu-item${opts.active === 'notes' ? ' active' : ''}" href="/app/notes" role="menuitem">Notes</a>
  <a class="sidebar-menu-item${opts.active === 'config' ? ' active' : ''}" href="/app/config" role="menuitem">Config</a>
  <a class="sidebar-menu-item${opts.active === 'api-keys' ? ' active' : ''}" href="/app/api-keys" role="menuitem">API Keys</a>
  <div class="sidebar-menu-sep" role="separator"></div>
  <div class="sidebar-menu-email">${esc(opts.email)}</div>
  <form method="post" action="/app/logout" role="none">
    <button class="sidebar-menu-logout" type="submit" role="menuitem">Log out</button>
  </form>
</div>
<div class="shell">
  <aside class="sidebar">
    <div class="logo" role="button" tabindex="0" aria-label="Recolher menu (mobile)">Expert Brain</div>
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
