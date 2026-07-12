import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { FONT_LINKS, THEME_COLOR, THEME_COLOR_LIGHT } from './styles.js';
import { readCookie } from './session.js';
import { assetVersion } from './asset-version.js';
import { releaseBannerHtml } from './releases-data.js';

// Lê a preferência de menu recolhido do cookie (gravado client-side pelo shell
// bundle). Server-side render evita o "flash" de menu abrindo/fechando ao trocar
// de página — navegação aqui é full page load, então o cookie sempre chega.
export function sidebarCollapsedFromReq(req: Request): boolean {
  return readCookie(req.headers.get('cookie'), 'eb_sidebar') === 'collapsed';
}

// Ícones do menu lateral — mesmos traços do bottom-nav (mobile) pra consistência.
const SIDEBAR_ICONS = {
  search:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>',
  home:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg>',
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
  theme:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
};

// O Inbox saiu da navegação (Onda 8, spec 70): ele mora na home como card de
// captura + triagem — a página /app/inbox segue existindo (link "ver tudo" do card
// e Web Share Target do PWA), mas sem item de menu nem badge de contagem.

// Identidade PWA compartilhada por TODO head servido — shell logado E login/erro
// (rodada PWA 11/07): instalar o app a partir da tela de login ficava sem manifest,
// sem theme-color e sem ícone iOS. apple-touch-icon dedicado 180x180 (o iOS ignora
// o manifest e busca este link; antes apontava pro 192 genérico sem `sizes`).
export const PWA_HEAD = `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLOR_LIGHT}">
<meta name="theme-color" content="${THEME_COLOR}">
<script src="/app/theme-boot.js?v=1"></script>
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Brain">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/expert-integrado-logo.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">`;

export async function renderShell(opts: {
  title: string;
  active: 'home' | 'notes' | 'graph' | 'tasks' | 'contacts' | 'config' | 'api-keys';
  email: string;
  body: string;
  env: Env;
  extraHead?: string;
  sidebarCollapsed?: boolean;
}): Promise<string> {
  const collapsed = opts.sidebarCollapsed === true;
  // Banner "Novidades" (spec 71): aparece em toda página logada até o dono
  // visitar /app/novidades após uma release nova. A própria página não mostra
  // o banner (já está nela).
  const releaseBanner = opts.title === 'Novidades' ? '' : await releaseBannerHtml(opts.env);
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8">
${PWA_HEAD}
<title>${esc(opts.title)} · Expert Brain</title>
${FONT_LINKS}
<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}">
${opts.extraHead ?? ''}
</head><body>
<div class="shell${collapsed ? ' sidebar-collapsed' : ''}">
  <aside class="sidebar">
    <div class="logo"><span class="logo-text">Expert Brain</span></div>
    <button class="nav-item nav-search" type="button" data-cmd-open title="Buscar (Ctrl+K)">${SIDEBAR_ICONS.search}<span class="nav-label">Buscar</span><kbd class="nav-kbd" aria-hidden="true">Ctrl+K</kbd></button>
    <a class="nav-item${opts.active === 'home' ? ' active' : ''}" href="/app" title="Início">${SIDEBAR_ICONS.home}<span class="nav-label">Início</span></a>
    <a class="nav-item${opts.active === 'graph' ? ' active' : ''}" href="/app/graph" title="Grafo">${SIDEBAR_ICONS.graph}<span class="nav-label">Grafo</span></a>
    <a class="nav-item${opts.active === 'notes' ? ' active' : ''}" href="/app/notes" title="Notas">${SIDEBAR_ICONS.notes}<span class="nav-label">Notas</span></a>
    <a class="nav-item${opts.active === 'tasks' ? ' active' : ''}" href="/app/tasks" title="Tarefas">${SIDEBAR_ICONS.tasks}<span class="nav-label">Tarefas</span></a>
    <a class="nav-item${opts.active === 'contacts' ? ' active' : ''}" href="/app/contacts" title="Contatos">${SIDEBAR_ICONS.contacts}<span class="nav-label">Contatos</span></a>
    <div class="bottom">
      <button class="nav-item nav-theme" type="button" data-theme-toggle title="Tema (auto/claro/escuro)">${SIDEBAR_ICONS.theme}<span class="nav-label" data-theme-label>Tema</span></button>
      <button class="sidebar-toggle" type="button" aria-label="Recolher menu" aria-expanded="${collapsed ? 'false' : 'true'}" title="Recolher menu (Ctrl+B)">${SIDEBAR_ICONS.chevron}<span class="nav-label">Recolher</span></button>
      <a class="nav-item${opts.active === 'config' ? ' active' : ''}" href="/app/config" title="Configurações">${SIDEBAR_ICONS.config}<span class="nav-label">Configurações</span></a>
      <div class="sidebar-user" title="${esc(opts.email)}">
        <span class="sidebar-avatar" aria-hidden="true">${esc((opts.email[0] ?? '?').toUpperCase())}</span>
        <span class="sidebar-email">${esc(opts.email)}</span>
        <form method="post" action="/app/logout"><button type="submit" class="sidebar-logout" title="Sair" aria-label="Sair">${SIDEBAR_ICONS.logout}</button></form>
      </div>
    </div>
  </aside>
  <main class="main">${releaseBanner}${opts.body}</main>
</div>
<nav class="bottom-nav" role="navigation" aria-label="Navegação principal">
  <button class="bottom-nav-item" type="button" data-cmd-open aria-label="Buscar">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
    <span>Buscar</span>
  </button>
  <a class="bottom-nav-item${opts.active === 'home' ? ' active' : ''}" href="/app" aria-label="Início">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg>
    <span>Início</span>
  </a>
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
  <a class="bottom-nav-item${opts.active === 'contacts' ? ' active' : ''}" href="/app/contacts" aria-label="Contatos">
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
      // The HTML shell is the cache-buster for the bundles (bundles are content-hash
      // versioned and immutable). Without no-store, browsers apply heuristic caching
      // to HTML lacking explicit cache headers, so a stale shell can keep pointing at
      // stale bundle URLs after deploy. Always fetch this fresh.
      'cache-control': 'no-store',
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
