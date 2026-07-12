import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { checkLoginAllowed, registerLoginFailure, clearLoginFailures, clientIp } from '../auth/rate-limit.js';
import {
  verifyRecoveryCode,
  consumeRecoveryCode,
  setOwnerPassword,
  passwordPolicyError,
} from '../auth/owner-password.js';
import { twoFactorEnabled, verifySecondFactor } from '../auth/twofactor.js';
import { FONT_LINKS } from './styles.js';
import { htmlResponse, PWA_HEAD } from './render.js';
import { assetVersion } from './asset-version.js';

// "Esqueci a senha" (spec 100-seguranca-conta/103): tela ÚNICA, sem estado
// intermediário — código de recuperação + senha nova (+ código do app quando o
// 2FA está ligado; recuperar senha NÃO pula o segundo fator). O código só é
// consumido DEPOIS da troca dar certo — falha em qualquer etapa preserva ele.

function renderRecoverPage(error: string | null, has2fa: boolean): string {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8">
${PWA_HEAD}
<title>Recuperar acesso · Expert Brain</title>
${FONT_LINKS}
<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}"></head>
<body><div class="login-wrap">
<h1>Recuperar acesso</h1>
<p class="subtitle">Use o código de recuperação que você guardou no 1Password pra definir uma senha nova.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/app/login/recover">
<label>Código de recuperação<input type="text" name="recovery" placeholder="XXXX-XXXX-XXXX" autocomplete="off" required autofocus></label>
${has2fa ? `<label>Código do app autenticador<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" required></label>` : ''}
<label>Senha nova<input type="password" name="password" minlength="10" required></label>
<label>Confirmar senha nova<input type="password" name="confirm" minlength="10" required></label>
<button type="submit">Trocar senha</button>
</form>
<p class="subtitle"><a href="/app/login">Voltar pro login</a></p>
</div></body></html>`;
}

function checkOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const url = new URL(req.url);
  return origin === url.origin;
}

export async function handleRecoverGet(_req: Request, env: Env): Promise<Response> {
  return htmlResponse(renderRecoverPage(null, await twoFactorEnabled(env)));
}

export async function handleRecoverPost(req: Request, env: Env): Promise<Response> {
  if (!checkOrigin(req)) return new Response('Acesso negado', { status: 403 });
  if (!env.OWNER_EMAIL || !env.SESSION_SECRET) {
    return new Response('Vault não configurado', { status: 503 });
  }
  const has2fa = await twoFactorEnabled(env);
  const form = await req.formData();
  const recovery = String(form.get('recovery') ?? '');
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  // Bucket próprio por IP (o form não tem e-mail) — mesmo KV/janela do login.
  const ip = clientIp(req);
  const gate = await checkLoginAllowed(env, ip, 'recovery');
  if (!gate.allowed) {
    const res = htmlResponse(renderRecoverPage('Muitas tentativas. Aguarde alguns minutos.', has2fa), 429);
    if (gate.retryAfterS) res.headers.set('retry-after', String(gate.retryAfterS));
    return res;
  }

  if (!(await verifyRecoveryCode(env, recovery))) {
    const fails = await registerLoginFailure(env, ip, 'recovery');
    console.warn('app/login/recover: invalid code', JSON.stringify({ ip, fails }));
    return htmlResponse(renderRecoverPage('Código de recuperação inválido.', has2fa), 401);
  }

  if (has2fa) {
    const kind = await verifySecondFactor(env, String(form.get('code') ?? ''), Date.now());
    if (!kind) {
      const fails = await registerLoginFailure(env, ip, 'recovery');
      console.warn('app/login/recover: invalid 2fa', JSON.stringify({ ip, fails }));
      return htmlResponse(renderRecoverPage('Código do app inválido.', has2fa), 401);
    }
  }

  const policyError = passwordPolicyError(password, confirm);
  if (policyError) return htmlResponse(renderRecoverPage(policyError, has2fa), 400);

  await setOwnerPassword(env, password);
  await consumeRecoveryCode(env);
  await clearLoginFailures(env, ip, 'recovery');
  console.warn('app/login/recover: password reset', JSON.stringify({ ip }));
  return new Response(null, {
    status: 302,
    headers: { location: '/app/login?recovered=1' },
  });
}
