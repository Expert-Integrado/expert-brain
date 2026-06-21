import { esc } from '../util/html.js';
import { NEBULA_CSS, FONT_LINKS } from './styles.js';
import { readCookie } from './session.js';
import { assetVersion } from './asset-version.js';

// Lê a preferência de menu recolhido do cookie (gravado client-side pelo shell
// bundle). Server-side render evita o "flash" de menu abrindo/fechando ao trocar
// de página — navegação aqui é full page load, então o cookie sempre chega.
export function sidebarCollapsedFromReq(req: Request): boolean {
  return readCookie(req.headers.get('cookie'), 'eb_sidebar') === 'collapsed';
}

// Ícones do menu lateral — mesmos traços do bottom-nav (mobile) pra consistência.
const SIDEBAR_ICONS = {
  graph:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8" y1="8" x2="11" y2="16"/><line x1="16" y1="8" x2="13" y2="16"/><line x1="9" y1="6" x2="15" y2="6"/></svg>',
  notes:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
  tasks:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  contacts:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  config:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  logout:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  chevron:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
};

export function renderShell(opts: {
  title: string;
  active: 'notes' | 'graph' | 'tasks' | 'config' | 'api-keys';
  email: string;
  body: string;
  extraHead?: string;
  sidebarCollapsed?: boolean;
}): string {
  const collapsed = opts.sidebarCollapsed === true;
  return `<!doctype html><html lang="pt-BR"><head>
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
<div class="shell${collapsed ? ' sidebar-collapsed' : ''}">
  <aside class="sidebar">
    <div class="logo"><span class="logo-text">Expert Brain</span></div>
    <a class="nav-item${opts.active === 'graph' ? ' active' : ''}" href="/app/graph" title="Grafo">${SIDEBAR_ICONS.graph}<span class="nav-label">Grafo</span></a>
    <a class="nav-item${opts.active === 'notes' ? ' active' : ''}" href="/app/notes" title="Notas">${SIDEBAR_ICONS.notes}<span class="nav-label">Notas</span></a>
    <a class="nav-item${opts.active === 'tasks' ? ' active' : ''}" href="/app/tasks" title="Tarefas">${SIDEBAR_ICONS.tasks}<span class="nav-label">Tarefas</span></a>
    <a class="nav-item" href="https://expert-contacts.contato-d9a.workers.dev" target="_blank" rel="noopener noreferrer" title="Contatos (Expert Contacts) — abre em nova aba">${SIDEBAR_ICONS.contacts}<span class="nav-label">Contatos</span></a>
    <a class="nav-item${opts.active === 'config' ? ' active' : ''}" href="/app/config" title="Configurações">${SIDEBAR_ICONS.config}<span class="nav-label">Configurações</span></a>
    <div class="bottom">
      <button class="sidebar-toggle" type="button" aria-label="Recolher menu" aria-expanded="${collapsed ? 'false' : 'true'}" title="Recolher menu (Ctrl+B)">${SIDEBAR_ICONS.chevron}<span class="nav-label">Recolher</span></button>
      <div class="sidebar-email" title="${esc(opts.email)}">${esc(opts.email)}</div>
      <form method="post" action="/app/logout"><button type="submit" class="sidebar-logout" title="Sair">${SIDEBAR_ICONS.logout}<span class="nav-label">Sair</span></button></form>
    </div>
  </aside>
  <main class="main">${opts.body}</main>
</div>
<nav class="bottom-nav" role="navigation" aria-label="Navegação principal">
  <a class="bottom-nav-item${opts.active === 'graph' ? ' active' : ''}" href="/app/graph" aria-label="Grafo">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8" y1="8" x2="11" y2="16"/><line x1="16" y1="8" x2="13" y2="16"/><line x1="9" y1="6" x2="15" y2="6"/></svg>
    <span>Grafo</span>
  </a>
  <a class="bottom-nav-item${opts.active === 'notes' ? ' active' : ''}" href="/app/notes" aria-label="Notas">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
    <span>Notas</span>
  </a>
  <a class="bottom-nav-item${opts.active === 'tasks' ? ' active' : ''}" href="/app/tasks" aria-label="Tarefas">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    <span>Tarefas</span>
  </a>
  <a class="bottom-nav-item" href="https://expert-contacts.contato-d9a.workers.dev" target="_blank" rel="noopener noreferrer" aria-label="Contatos (Expert Contacts) — abre em nova aba">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    <span>Contatos</span>
  </a>
  <a class="bottom-nav-item${opts.active === 'config' ? ' active' : ''}" href="/app/config" aria-label="Configurações">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    <span>Config</span>
  </a>
  <form class="bottom-nav-logout-form" method="post" action="/app/logout" role="none">
    <button class="bottom-nav-item bottom-nav-logout" type="submit" aria-label="Sair">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      <span>Sair</span>
    </button>
  </form>
</nav>
<script src="/app/shell/bundle.js?v=${assetVersion('shell.bundle.js')}" defer></script>
</body></html>`;
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Google Fonts is allow-listed for style-src and font-src so the Fraunces/Manrope
      // stylesheets and woff2 files load. Everything else stays 'self'-only.
      // frame-ancestors 'none' + X-Frame-Options: DENY block clickjacking even
      // for browsers that ignore one or the other.
      'content-security-policy':
        "default-src 'self'; " +
        "script-src 'self'; " +
        "worker-src 'self'; " +
        "manifest-src 'self'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    },
  });
}
