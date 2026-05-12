import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { verifyPassword } from '../auth/password.js';
import { signSession, sessionCookie } from './session.js';
import { NEBULA_CSS, FONT_LINKS } from './styles.js';
import { htmlResponse } from './render.js';

function renderLoginPage(error: string | null, next: string): string {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar · Expert Brain</title>
${FONT_LINKS}
<style>${NEBULA_CSS}</style></head>
<body><div class="login-wrap">
<h1>Expert Brain</h1>
<p class="subtitle">Seu cérebro de pensamento cross-domain.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/app/login">
<input type="hidden" name="next" value="${esc(next)}">
<label>E-mail<input type="email" name="email" required autofocus></label>
<label>Senha<input type="password" name="password" required></label>
<button type="submit">Entrar</button>
</form></div></body></html>`;
}

export async function handleLoginGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = url.searchParams.get('next') ?? '/app/graph';
  return htmlResponse(renderLoginPage(null, next));
}

function checkOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const url = new URL(req.url);
  return origin === url.origin;
}

export async function handleLoginPost(req: Request, env: Env): Promise<Response> {
  if (!checkOrigin(req)) return new Response('Acesso negado', { status: 403 });
  if (!env.OWNER_EMAIL || !env.OWNER_PASSWORD_HASH || !env.SESSION_SECRET) {
    return new Response('Vault não configurado', { status: 503 });
  }
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/app/graph');

  const emailMatch = email === env.OWNER_EMAIL;
  const passwordOk = emailMatch && (await verifyPassword(password, env.OWNER_PASSWORD_HASH));
  if (!emailMatch || !passwordOk) {
    return htmlResponse(renderLoginPage('Credenciais inválidas.', next), 401);
  }

  const token = await signSession(env.OWNER_EMAIL, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
  const safeNext =
    next.startsWith('/app/') && !next.includes('//') && !next.includes('..')
      ? next
      : '/app/graph';
  return new Response(null, {
    status: 302,
    headers: {
      location: safeNext,
      'set-cookie': sessionCookie(token),
    },
  });
}

export async function handleLogoutPost(req: Request): Promise<Response> {
  if (!checkOrigin(req)) return new Response('Acesso negado', { status: 403 });
  return new Response(null, {
    status: 302,
    headers: {
      location: '/app/login',
      'set-cookie': sessionCookie('', { clear: true }),
    },
  });
}
