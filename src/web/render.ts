import { esc } from '../util/html.js';
import { NEBULA_CSS, FONT_LINKS } from './styles.js';

export function renderShell(opts: {
  title: string;
  active: 'notes' | 'graph' | 'config';
  email: string;
  body: string;
  extraHead?: string;
}): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · Mind Vault</title>
${FONT_LINKS}
<style>${NEBULA_CSS}</style>
${opts.extraHead ?? ''}
</head><body>
<div class="shell">
  <aside class="sidebar">
    <div class="logo">Mind Vault</div>
    <a class="nav-item${opts.active === 'graph' ? ' active' : ''}" href="/app/graph">Graph</a>
    <a class="nav-item${opts.active === 'notes' ? ' active' : ''}" href="/app/notes">Notes</a>
    <a class="nav-item${opts.active === 'config' ? ' active' : ''}" href="/app/config">Config</a>
    <div class="bottom">
      <div>${esc(opts.email)}</div>
      <form method="post" action="/app/logout"><button type="submit">Log out</button></form>
    </div>
  </aside>
  <main class="main">${opts.body}</main>
</div>
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
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data:; " +
        "connect-src 'self'",
    },
  });
}
