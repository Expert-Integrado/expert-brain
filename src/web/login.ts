import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { verifyPassword } from '../auth/password.js';
import { checkLoginAllowed, registerLoginFailure, clearLoginFailures, clientIp } from '../auth/rate-limit.js';
import { signSession, sessionCookie } from './session.js';
import { FONT_LINKS } from './styles.js';
import { htmlResponse } from './render.js';
import { assetVersion } from './asset-version.js';

function renderLoginPage(error: string | null, next: string): string {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar · Expert Brain</title>
${FONT_LINKS}
<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}"></head>
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

// Sanitiza o `next` do login contra open redirect, sem derrubar querystring legítima.
// A checagem de path traversal ('..', '//') só faz sentido no PATH — dot-segments e
// barras duplas na QUERY são inertes (RFC 3986 §5.2.4 só normaliza o path), mas texto
// compartilhado via Web Share Target (specs/50-console-v2/68-pwa-instalavel.md) pode
// legitimamente conter '..' (reticências) nos params `title`/`text`/`url` — checar a
// string inteira derrubava esse conteúdo de volta pro login. Split no primeiro '?'
// mantém a defesa (path ainda precisa começar com '/app/' e não pode ter '..'/'//')
// sem penalizar a query.
function safeNextPath(next: string): string {
  const qIndex = next.indexOf('?');
  const path = qIndex === -1 ? next : next.slice(0, qIndex);
  const query = qIndex === -1 ? '' : next.slice(qIndex);
  if (path.startsWith('/app/') && !path.includes('//') && !path.includes('..')) {
    return path + query;
  }
  return '/app/graph';
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

  // Mesmo rate limit (e mesmo bucket IP+e-mail) do POST /authorize — é a mesma
  // senha, então as falhas dos dois endpoints somam (spec 10-backend/18).
  const ip = clientIp(req);
  const gate = await checkLoginAllowed(env, ip, email);
  if (!gate.allowed) {
    const res = htmlResponse(renderLoginPage('Muitas tentativas. Aguarde alguns minutos.', next), 429);
    if (gate.retryAfterS) res.headers.set('retry-after', String(gate.retryAfterS));
    return res;
  }

  const emailMatch = email === env.OWNER_EMAIL;
  const passwordOk = emailMatch && (await verifyPassword(password, env.OWNER_PASSWORD_HASH));
  if (!emailMatch || !passwordOk) {
    const fails = await registerLoginFailure(env, ip, email);
    console.warn('app/login: failed login', JSON.stringify({ ip, fails }));
    return htmlResponse(renderLoginPage('Credenciais inválidas.', next), 401);
  }
  await clearLoginFailures(env, ip, email);

  const token = await signSession(env.OWNER_EMAIL, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
  const safeNext = safeNextPath(next);
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
