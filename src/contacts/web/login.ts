import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { verifyPassword } from '../auth/password.js';
import { signSession, sessionCookie, getSessionKeyMaterial, bumpSessionEpoch } from './session.js';
import { checkLoginAllowed, registerLoginFailure, clearLoginFailures, clientIp } from './rate-limit.js';
import { NEBULA_CSS, FONT_LINKS } from './styles.js';
import { htmlResponse } from './render.js';

function renderLoginPage(error: string | null, next: string): string {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#070a13">
<title>Entrar · Expert Console</title>
${FONT_LINKS}
<style>${NEBULA_CSS}</style></head>
<body><div class="login-wrap">
<h1>Expert Console</h1>
<p class="subtitle">Seu front único multi-vault.</p>
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

  // Rate limit ANTES do PBKDF2 (spec 20-frontend/27): o hash é capado em 100k
  // iterações pelo runtime, então o freio a brute-force tem que ser externo.
  const ip = clientIp(req);
  const rl = await checkLoginAllowed(env, ip, email);
  if (!rl.allowed) {
    const res = htmlResponse(renderLoginPage('Muitas tentativas. Aguarde alguns minutos.', next), 429);
    res.headers.set('retry-after', String(rl.retryAfterS ?? 60));
    return res;
  }

  const emailMatch = email === env.OWNER_EMAIL;
  const passwordOk = emailMatch && (await verifyPassword(password, env.OWNER_PASSWORD_HASH));
  if (!emailMatch || !passwordOk) {
    // E-mail errado conta IGUAL — senão a comparação de e-mail vira oráculo grátis.
    const fails = await registerLoginFailure(env, ip, email);
    console.warn('login: failed attempt', JSON.stringify({ ip, fails }));
    return htmlResponse(renderLoginPage('Credenciais inválidas.', next), 401);
  }
  await clearLoginFailures(env, ip, email);

  const token = await signSession(env.OWNER_EMAIL, await getSessionKeyMaterial(env), Math.floor(Date.now() / 1000));
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

export async function handleLogoutPost(req: Request, env: Env): Promise<Response> {
  if (!checkOrigin(req)) return new Response('Acesso negado', { status: 403 });
  // Console é single-user: logout == logout-all. O bump do epoch invalida TODAS
  // as sessões emitidas (spec 20-frontend/27) — não só o cookie deste navegador.
  await bumpSessionEpoch(env);
  return new Response(null, {
    status: 302,
    headers: {
      location: '/app/login',
      'set-cookie': sessionCookie('', { clear: true }),
    },
  });
}
