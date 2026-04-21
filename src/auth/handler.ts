import type { Env } from '../env.js';
import { handleRoot, handleProvision, handleStatus, isSetup } from './setup.js';
import { verifyPassword } from './password.js';
import { NEBULA_CSS, FONT_LINKS } from '../web/styles.js';
import { esc } from '../util/html.js';
import { handleApp } from '../web/handler.js';

export const authHandler = {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/app')) {
      const res = await handleApp(req, env);
      if (res) return res;
    }

    if (url.pathname === '/') return handleRoot(req, env);
    if (url.pathname === '/status') return handleStatus(env);
    if (url.pathname === '/setup/provision' && req.method === 'POST') return handleProvision(env);

    if (url.pathname === '/authorize') {
      if (!isSetup(env)) return new Response('Vault not configured', { status: 503 });
      const provider = (env as any).OAUTH_PROVIDER;
      if (req.method === 'POST') {
        const form = await req.formData();
        const email = String(form.get('email') ?? '');
        const password = String(form.get('password') ?? '');
        if (email !== env.OWNER_EMAIL) return renderLogin('Invalid credentials.', url.search);
        const ok = await verifyPassword(password, env.OWNER_PASSWORD_HASH!);
        if (!ok) return renderLogin('Invalid credentials.', url.search);
        // parseAuthRequest expects the original GET request; reconstruct it from the query string
        const authReq = await provider.parseAuthRequest(new Request(url.toString(), { method: 'GET' }));
        const result = await provider.completeAuthorization({
          request: authReq,
          userId: email,
          metadata: { email },
          scope: authReq.scope?.length ? authReq.scope : ['mcp'],
          props: { email, loggedInAt: Date.now() },
        });
        return Response.redirect(result.redirectTo, 302);
      }
      return renderLogin(null, url.search);
    }

    return new Response('Not found', { status: 404 });
  },
};

function renderLogin(error: string | null, qs: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize · Expert Brain</title>
${FONT_LINKS}
<style>${NEBULA_CSS}</style></head>
<body><div class="login-wrap">
<h1>Expert Brain</h1>
<p class="subtitle">Authorize Claude to access your vault.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/authorize${esc(qs)}">
<label>Email<input type="email" name="email" required autofocus></label>
<label>Passphrase<input type="password" name="password" required></label>
<button type="submit">Authorize</button>
</form></div></body></html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data:; " +
          "connect-src 'self'",
      },
    }
  );
}
