import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { verifyOwnerPassword } from '../auth/owner-password.js';
import { checkLoginAllowed, registerLoginFailure, clearLoginFailures, clientIp } from '../auth/rate-limit.js';
import { signSession, sessionCookie, readCookie } from './session.js';
import {
  twoFactorEnabled,
  signTwoFactorToken,
  verifyTwoFactorToken,
  verifySecondFactor,
  twoFactorCookie,
  TWOFA_COOKIE,
} from '../auth/twofactor.js';
import { FONT_LINKS } from './styles.js';
import { htmlResponse, PWA_HEAD } from './render.js';
import { assetVersion } from './asset-version.js';

function renderLoginPage(error: string | null, next: string, notice: string | null = null): string {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8">
${PWA_HEAD}
<title>Entrar · Expert Brain</title>
${FONT_LINKS}
<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}"></head>
<body><div class="login-wrap">
<h1>Expert Brain</h1>
<p class="subtitle">Seu cérebro de pensamento cross-domain.</p>
${notice ? `<p class="login-notice">${esc(notice)}</p>` : ''}
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/app/login">
<input type="hidden" name="next" value="${esc(next)}">
<label>E-mail<input type="email" name="email" required autofocus></label>
<label>Senha<input type="password" name="password" required></label>
<button type="submit">Entrar</button>
</form>
<p class="subtitle"><a href="/app/login/recover">Esqueci a senha</a></p>
</div></body></html>`;
}

export async function handleLoginGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = url.searchParams.get('next') ?? '/app';
  const notice =
    url.searchParams.get('recovered') === '1'
      ? 'Senha trocada com sucesso. Entre com a senha nova.'
      : null;
  return htmlResponse(renderLoginPage(null, next, notice));
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
  // '/app' exato (sem barra) é a home — destino default pós-login desde a Onda 5.
  if ((path === '/app' || path.startsWith('/app/')) && !path.includes('//') && !path.includes('..')) {
    return path + query;
  }
  return '/app';
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
  const next = String(form.get('next') ?? '/app');

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
  // Senha efetiva = meta.owner_password_hash com fallback pro secret (spec 103).
  const passwordOk = emailMatch && (await verifyOwnerPassword(env, password));
  if (!emailMatch || !passwordOk) {
    const fails = await registerLoginFailure(env, ip, email);
    console.warn('app/login: failed login', JSON.stringify({ ip, fails }));
    return htmlResponse(renderLoginPage('Credenciais inválidas.', next), 401);
  }
  await clearLoginFailures(env, ip, email);

  const now = Math.floor(Date.now() / 1000);

  // 2FA ligado: a senha certa NÃO emite sessão — emite o token intermediário
  // (cookie próprio, secret derivado — ver src/auth/twofactor.ts) e manda pra
  // tela do código. A sessão só nasce no POST /app/login/2fa.
  if (await twoFactorEnabled(env)) {
    const twofa = await signTwoFactorToken(env.OWNER_EMAIL, env, now);
    return new Response(null, {
      status: 302,
      headers: {
        location: `/app/login/2fa?next=${encodeURIComponent(next)}`,
        'set-cookie': twoFactorCookie(twofa),
      },
    });
  }

  const token = await signSession(env.OWNER_EMAIL, env.SESSION_SECRET, now);
  const safeNext = safeNextPath(next);
  return new Response(null, {
    status: 302,
    headers: {
      location: safeNext,
      'set-cookie': sessionCookie(token),
    },
  });
}

function renderTwoFactorPage(error: string | null, next: string): string {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8">
${PWA_HEAD}
<title>Verificação · Expert Brain</title>
${FONT_LINKS}
<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}"></head>
<body><div class="login-wrap">
<h1>Verificação em duas etapas</h1>
<p class="subtitle">Digite o código de 6 dígitos do seu app autenticador — ou um dos seus códigos reserva.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/app/login/2fa">
<input type="hidden" name="next" value="${esc(next)}">
<label>Código<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" required autofocus></label>
<button type="submit">Confirmar</button>
</form>
<p class="subtitle"><a href="/app/login">Voltar pro login</a></p>
</div></body></html>`;
}

/** Portador válido do token intermediário, ou null (aí o caller manda pro login). */
async function twoFactorBearer(req: Request, env: Env): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(req.headers.get('cookie'), TWOFA_COOKIE);
  if (!token) return null;
  return verifyTwoFactorToken(token, env, Math.floor(Date.now() / 1000));
}

export async function handleTwoFactorGet(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const next = url.searchParams.get('next') ?? '/app';
  const email = await twoFactorBearer(req, env);
  if (!email) {
    return new Response(null, {
      status: 302,
      headers: { location: `/app/login?next=${encodeURIComponent(next)}` },
    });
  }
  return htmlResponse(renderTwoFactorPage(null, next));
}

export async function handleTwoFactorPost(req: Request, env: Env): Promise<Response> {
  if (!checkOrigin(req)) return new Response('Acesso negado', { status: 403 });
  const form = await req.formData();
  const code = String(form.get('code') ?? '');
  const next = String(form.get('next') ?? '/app');

  const email = await twoFactorBearer(req, env);
  if (!email) {
    // Token intermediário expirou (5 min) ou não existe: recomeça do login.
    return new Response(null, {
      status: 302,
      headers: { location: `/app/login?next=${encodeURIComponent(next)}` },
    });
  }

  // Bucket separado do de senha: errar código não derruba o login por senha e
  // vice-versa, mas o mecanismo KV (5 falhas/15min) é o mesmo.
  const ip = clientIp(req);
  const gate = await checkLoginAllowed(env, ip, `2fa:${email}`);
  if (!gate.allowed) {
    const res = htmlResponse(renderTwoFactorPage('Muitas tentativas. Aguarde alguns minutos.', next), 429);
    if (gate.retryAfterS) res.headers.set('retry-after', String(gate.retryAfterS));
    return res;
  }

  const kind = await verifySecondFactor(env, code, Date.now());
  if (!kind) {
    const fails = await registerLoginFailure(env, ip, `2fa:${email}`);
    console.warn('app/login/2fa: failed code', JSON.stringify({ ip, fails }));
    return htmlResponse(renderTwoFactorPage('Código inválido.', next), 401);
  }
  await clearLoginFailures(env, ip, `2fa:${email}`);

  const token = await signSession(email, env.SESSION_SECRET!, Math.floor(Date.now() / 1000));
  const headers = new Headers({ location: safeNextPath(next) });
  headers.append('set-cookie', sessionCookie(token));
  headers.append('set-cookie', twoFactorCookie('', { clear: true }));
  return new Response(null, { status: 302, headers });
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
