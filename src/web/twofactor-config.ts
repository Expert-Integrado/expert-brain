import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import {
  startTwoFactor,
  cancelTwoFactorSetup,
  confirmTwoFactor,
  disableTwoFactor,
} from '../auth/twofactor.js';
import { otpauthUri } from '../auth/totp.js';

// Card "Segurança" da aba Sistema + endpoints do liga/desliga do 2FA
// (spec 100-seguranca-conta/102). Módulo próprio: config.ts só monta a página.

// Backup codes aparecem UMA vez: o confirm grava no KV com TTL curto e
// redireciona com id opaco; o GET consome e deleta (mesmo padrão M6 do
// flash da chave de API em api-keys.ts — nada de segredo em query/histórico).
export function twoFactorFlashKey(id: string): string {
  return `2faflash:${id}`;
}

export async function handleTwoFactorStartPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  try {
    await startTwoFactor(env);
  } catch {
    // Já ligado (duplo submit / aba velha): volta pro card sem mudar nada.
  }
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=2fa#twofactor' } });
}

export async function handleTwoFactorCancelPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  await cancelTwoFactorSetup(env);
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=2fa#twofactor' } });
}

export async function handleTwoFactorConfirmPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const code = String(form.get('code') ?? '');
  const backupCodes = await confirmTwoFactor(env, code, Date.now());
  if (!backupCodes) {
    return new Response(null, {
      status: 302,
      headers: { location: '/app/config?saved=2fa&tferr=code#twofactor' },
    });
  }
  const flashId = crypto.randomUUID().replace(/-/g, '');
  await env.OAUTH_KV.put(twoFactorFlashKey(flashId), backupCodes.join('\n'), { expirationTtl: 600 });
  return new Response(null, {
    status: 302,
    headers: { location: `/app/config?saved=2fa&tfflash=${flashId}#twofactor` },
  });
}

export async function handleTwoFactorDisablePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const code = String(form.get('code') ?? '');
  const ok = await disableTwoFactor(env, code, Date.now());
  return new Response(null, {
    status: 302,
    headers: {
      location: ok
        ? '/app/config?saved=2fa#twofactor'
        : '/app/config?saved=2fa&tferr=disable#twofactor',
    },
  });
}

export interface TwoFactorCardState {
  enabled: boolean;
  enabledAt: number | null;
  backupRemaining: number;
  pendingSecret: string | null;
  ownerEmail: string;
  /** Backup codes recém-gerados (flash one-time) — null fora do redirect do confirm. */
  freshBackupCodes: string[] | null;
  /** 'code' = confirmação falhou; 'disable' = desativação falhou. */
  error: string | null;
}

export function renderTwoFactorCard(s: TwoFactorCardState): string {
  const errorBanner =
    s.error === 'code'
      ? `<p class="error">Código inválido. Confira no app se o código é desta conta e tente de novo.</p>`
      : s.error === 'disable'
        ? `<p class="error">Código inválido — a verificação em duas etapas continua ligada.</p>`
        : '';

  let flash = '';
  if (s.freshBackupCodes && s.freshBackupCodes.length) {
    const list = s.freshBackupCodes.map((c) => `<code>${esc(c)}</code>`).join(' ');
    flash = `<div class="key-flash" id="tf-flash">
      <p><strong>Verificação em duas etapas LIGADA.</strong> Guarde os códigos reserva abaixo no 1Password — cada um entra <strong>uma única vez</strong> no lugar do código do app (celular perdido, app apagado). <strong>Eles não aparecem de novo.</strong></p>
      <p class="tf-codes">${list}</p>
      <input type="text" readonly id="tf-flash-value" class="key-flash-value" value="${esc(s.freshBackupCodes.join(' '))}" aria-label="Códigos reserva">
      <button type="button" data-copy="tf-flash-value">Copiar todos</button>
    </div>`;
  }

  let body: string;
  if (s.enabled || s.freshBackupCodes) {
    const since = s.enabledAt
      ? new Date(s.enabledAt * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      : null;
    const remaining = s.freshBackupCodes ? s.freshBackupCodes.length : s.backupRemaining;
    body = `
      <p><span class="badge-pill badge-ok">● Ativa${since ? ` desde ${esc(since)}` : ''}</span> &nbsp;·&nbsp; ${remaining} código${remaining === 1 ? '' : 's'} reserva restante${remaining === 1 ? '' : 's'}</p>
      <p style="color:var(--text-dim);font-size:13px">Todo login (site e autorização de agentes) pede a senha E um código de 6 dígitos do seu app. Pra desligar, confirme com um código válido (do app ou um reserva).</p>
      <form method="post" action="/app/config/2fa/disable" class="row" style="gap:8px;flex-wrap:wrap">
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" required aria-label="Código de verificação" style="max-width:140px">
        <button type="submit" class="btn btn-danger">Desativar</button>
      </form>`;
  } else if (s.pendingSecret) {
    const uri = otpauthUri(s.pendingSecret, s.ownerEmail, 'Expert Brain');
    body = `
      <p><strong>Passo 1.</strong> Cadastre este código secreto no seu app: no 1Password, edite o item do Brain e adicione um campo <strong>senha de uso único</strong>, colando o código. No celular (Google Authenticator etc.), <a href="${esc(uri)}">toque aqui</a> ou digite o código manualmente.</p>
      <p><code class="tf-secret" id="tf-secret-value">${esc(s.pendingSecret)}</code> <button type="button" data-copy="tf-secret-value" class="btn btn-sm">Copiar</button></p>
      <p><strong>Passo 2.</strong> Digite o código de 6 dígitos que o app está mostrando agora — isso prova que deu certo antes de ligar (você não fica trancado fora).</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <form method="post" action="/app/config/2fa/confirm" class="row" style="gap:8px">
          <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" required aria-label="Código do app" style="max-width:140px">
          <button type="submit" class="btn btn-primary">Confirmar e ligar</button>
        </form>
        <form method="post" action="/app/config/2fa/cancel">
          <button type="submit" class="btn">Cancelar configuração</button>
        </form>
      </div>`;
  } else {
    body = `
      <p style="color:var(--text-dim)">Além da senha, o login passa a pedir um código de 6 dígitos gerado no seu app (1Password, Google Authenticator). Se alguém descobrir sua senha, ainda não entra — nem no site, nem autorizando um agente novo.</p>
      <form method="post" action="/app/config/2fa/start">
        <button type="submit" class="btn btn-primary">Ativar verificação em duas etapas</button>
      </form>`;
  }

  return `<div class="card" id="twofactor">
    <h2>Segurança</h2>
    ${errorBanner}
    ${flash}
    ${body}
  </div>`;
}
