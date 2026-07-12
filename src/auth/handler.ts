import type { Env } from '../env.js';
import { handleRoot, handleProvision, handleStatus, handleBackfillSimilar, isSetup } from './setup.js';
import { verifyPassword } from './password.js';
import { checkLoginAllowed, registerLoginFailure, clearLoginFailures, clientIp } from './rate-limit.js';
import { FONT_LINKS } from '../web/styles.js';
import { assetVersion } from '../web/asset-version.js';
import { esc } from '../util/html.js';
import { handleApp } from '../web/handler.js';
import { handleSharePage, handleShareCommentPost, handleShareMedia, shareNotFound, SHARE_TOKEN_RE } from '../web/share.js';
import { handleMailboxSummary, handleWhoami } from '../web/mailbox-api.js';
import { handleProjectSharePage, handleProjectShareCommentPost, PROJECT_SHARE_TOKEN_RE } from '../web/project-share.js';
import { notFoundResponse, internalErrorResponse } from '../web/error-pages.js';

export const authHandler = {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/app')) {
      // Casca 5xx com id de correlação (spec 97): exceção num handler de página
      // vira página com marca (o id vai junto pro log). APIs recebem texto puro.
      try {
        const res = await handleApp(req, env);
        if (res) return res;
      } catch (err) {
        return internalErrorResponse(req, err);
      }
    }

    // Rota PÚBLICA read-only de nota/task compartilhada (SEM auth). Vive fora de /app,
    // então entra ANTES do fallback 404 abaixo e nunca é interceptada pelo handleApp.
    // GET renderiza a nota (task → com thread de comentários); POST /s/<token>/comment
    // grava comentário de convidado (spec 53, só task); GET /s/<token>/media/<id> serve
    // anexo de share com mídia opt-in (spec 33). Token fora do formato ou método
    // errado → mesmo 404 genérico.
    if (url.pathname.startsWith('/s/')) {
      const rest = url.pathname.slice('/s/'.length);
      if (rest.endsWith('/comment')) {
        const token = rest.slice(0, -'/comment'.length);
        if (req.method === 'POST' && SHARE_TOKEN_RE.test(token)) {
          return handleShareCommentPost(req, env, token);
        }
        return shareNotFound();
      }
      const mediaMatch = rest.match(/^([^/]+)\/media\/([^/]+)$/);
      if (mediaMatch) {
        if (req.method === 'GET' && SHARE_TOKEN_RE.test(mediaMatch[1])) {
          return handleShareMedia(req, env, mediaMatch[1], mediaMatch[2]);
        }
        return shareNotFound();
      }
      if (req.method === 'GET' && SHARE_TOKEN_RE.test(rest)) {
        return handleSharePage(req, env, rest);
      }
      return shareNotFound();
    }

    // Board compartilhado por PROJETO (spec 85): /p/<token>, mesmo racional do /s/
    // (público, fora de /app, 404 neutro pra token fora do formato/método errado).
    if (url.pathname.startsWith('/p/')) {
      const rest = url.pathname.slice('/p/'.length);
      if (rest.endsWith('/comment')) {
        const token = rest.slice(0, -'/comment'.length);
        if (req.method === 'POST' && PROJECT_SHARE_TOKEN_RE.test(token)) {
          return handleProjectShareCommentPost(req, env, token);
        }
        return shareNotFound();
      }
      if (req.method === 'GET' && PROJECT_SHARE_TOKEN_RE.test(rest)) {
        return handleProjectSharePage(req, env, rest);
      }
      return shareNotFound();
    }

    if (url.pathname === '/') return handleRoot(req, env);
    if (url.pathname === '/status') return handleStatus(env);
    // Heartbeat da frota (spec 82/83): "tem algo pra mim?" com Bearer PAT, sem
    // sessão MCP. Read-only, no-store — o cron/hook dos dispositivos bate aqui.
    if (url.pathname === '/api/mailbox/summary' && req.method === 'GET') return handleMailboxSummary(req, env);
    // Identidade da credencial (spec 87): a máquina confere COMO QUEM ela assina.
    if (url.pathname === '/api/whoami' && req.method === 'GET') return handleWhoami(req, env);
    if (url.pathname === '/setup/provision' && req.method === 'POST') return handleProvision(req, env);
    if (url.pathname === '/setup/backfill-similar' && req.method === 'POST') return handleBackfillSimilar(req, env);

    if (url.pathname === '/authorize') {
      if (!isSetup(env)) return new Response('Vault não configurado', { status: 503 });
      const provider = (env as any).OAUTH_PROVIDER;
      if (req.method === 'POST') {
        const form = await req.formData();
        const email = String(form.get('email') ?? '');
        const password = String(form.get('password') ?? '');
        // Rate limit ANTES de tocar no PBKDF2 (spec 10-backend/18). E-mail errado
        // também conta falha — senão o check de e-mail vira oráculo grátis.
        const ip = clientIp(req);
        const gate = await checkLoginAllowed(env, ip, email);
        if (!gate.allowed) {
          return renderLogin('Muitas tentativas. Aguarde alguns minutos.', url.search, 429, gate.retryAfterS);
        }
        const emailOk = email === env.OWNER_EMAIL;
        const ok = emailOk && (await verifyPassword(password, env.OWNER_PASSWORD_HASH!));
        if (!ok) {
          const fails = await registerLoginFailure(env, ip, email);
          console.warn('authorize: failed login', JSON.stringify({ ip, fails }));
          return renderLogin('Credenciais inválidas.', url.search);
        }
        await clearLoginFailures(env, ip, email);
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

    // 404 com marca pra navegação HTML; texto puro pro resto (spec 97).
    return notFoundResponse(req);
  },
};

function renderLogin(error: string | null, qs: string, status = 200, retryAfterS?: number): Response {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar · Expert Brain</title>
${FONT_LINKS}
<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}"></head>
<body><div class="login-wrap">
<h1>Expert Brain</h1>
<p class="subtitle">Autorize o Claude a acessar seu vault.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/authorize${esc(qs)}">
<label>E-mail<input type="email" name="email" required autofocus></label>
<label>Senha<input type="password" name="password" required></label>
<button type="submit">Autorizar</button>
</form></div></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(retryAfterS ? { 'retry-after': String(retryAfterS) } : {}),
        // Same reasoning as web/render.ts htmlResponse: HTML must never be
        // heuristically cached by the browser, or a stale page can linger post-deploy.
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'self'; " +
          "script-src 'self'; " +
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
    }
  );
}
