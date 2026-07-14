import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import {
  verifyOwnerPassword,
  setOwnerPassword,
  passwordPolicyError,
  generateRecoveryCode,
  recoveryCodeInfo,
  PASSWORD_MIN_LEN,
} from '../auth/owner-password.js';

// Card "Senha e recuperação" da aba Sistema (spec 100-seguranca-conta/103):
// trocar a senha logado (exige a atual — sessão roubada não troca sozinha) e
// gerar o código de recuperação usado no "Esqueci a senha".

// Mesmo padrão one-time do flash de backup codes: o código de recuperação
// aparece UMA vez, via id opaco consumido do KV.
export function recoveryFlashKey(id: string): string {
  return `rcflash:${id}`;
}

export async function handlePasswordChangePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const current = String(form.get('current') ?? '');
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  if (!(await verifyOwnerPassword(env, current))) {
    return new Response(null, {
      status: 302,
      headers: { location: '/app/config?saved=pw&pwerr=current#password' },
    });
  }
  const policyError = passwordPolicyError(password, confirm);
  if (policyError) {
    const code = password.length < PASSWORD_MIN_LEN ? 'weak' : 'match';
    return new Response(null, {
      status: 302,
      headers: { location: `/app/config?saved=pw&pwerr=${code}#password` },
    });
  }
  await setOwnerPassword(env, password);
  return new Response(null, {
    status: 302,
    headers: { location: '/app/config?saved=pw&pwok=1#password' },
  });
}

export async function handleRecoveryCodePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const code = await generateRecoveryCode(env, Date.now());
  const flashId = crypto.randomUUID().replace(/-/g, '');
  await env.OAUTH_KV.put(recoveryFlashKey(flashId), code, { expirationTtl: 600 });
  return new Response(null, {
    status: 302,
    headers: { location: `/app/config?saved=pw&rcflash=${flashId}#password` },
  });
}

export interface PasswordCardState {
  /** null = nenhum código de recuperação ativo. */
  recovery: { createdAt: number | null } | null;
  /** Código recém-gerado (flash one-time) — null fora do redirect. */
  freshRecoveryCode: string | null;
  /** 'current' | 'weak' | 'match' — erro da troca de senha. */
  error: string | null;
  /** Senha trocada com sucesso (?pwok=1). */
  changed: boolean;
}

export function renderPasswordCard(s: PasswordCardState): string {
  const errorBanner =
    s.error === 'current'
      ? `<p class="error">Senha atual incorreta — nada foi alterado.</p>`
      : s.error === 'weak'
        ? `<p class="error">A senha nova precisa de pelo menos ${PASSWORD_MIN_LEN} caracteres — uma frase curta funciona bem.</p>`
        : s.error === 'match'
          ? `<p class="error">A confirmação não bate com a senha nova — nada foi alterado.</p>`
          : '';
  const okBanner = s.changed
    ? `<p class="login-notice">Senha trocada. Use a nova no próximo login.</p>`
    : '';

  let flash = '';
  if (s.freshRecoveryCode) {
    flash = `<div class="key-flash" id="rc-flash">
      <p><strong>Código de recuperação gerado.</strong> Guarde no 1Password (ou num papel seguro) — é ele que destrava o "Esqueci a senha". Entra <strong>uma única vez</strong> e <strong>não aparece de novo</strong>.</p>
      <p><code class="tf-secret" id="rc-flash-value">${esc(s.freshRecoveryCode)}</code> <button type="button" data-copy="rc-flash-value" class="btn btn-sm">Copiar</button></p>
    </div>`;
  }

  const recoveryState = s.freshRecoveryCode
    ? ''
    : s.recovery
      ? `<p><span class="badge-pill badge-ok">● Código ativo</span>${
          s.recovery.createdAt
            ? ` &nbsp;·&nbsp; gerado em ${esc(new Date(s.recovery.createdAt * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}`
            : ''
        }</p>`
      : `<p><span class="badge-pill badge-warn">○ Nenhum código de recuperação</span> — se esquecer a senha, não há como recuperar pelo site.</p>`;

  return `<div class="card" id="password">
    <div class="cfg-head"><h2>Senha e recuperação</h2></div>
    ${errorBanner}
    ${okBanner}
    ${flash}
    <h3 style="font-size:14px;margin:8px 0 4px">Trocar senha</h3>
    <form method="post" action="/app/config/password" class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <label style="font-size:13px">Senha atual<br><input type="password" class="input" name="current" autocomplete="current-password" required></label>
      <label style="font-size:13px">Senha nova<br><input type="password" class="input" name="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LEN}" required></label>
      <label style="font-size:13px">Confirmar<br><input type="password" class="input" name="confirm" autocomplete="new-password" minlength="${PASSWORD_MIN_LEN}" required></label>
      <button type="submit" class="btn btn-primary">Trocar</button>
    </form>
    <h3 style="font-size:14px;margin:16px 0 4px">Esqueci a senha — código de recuperação</h3>
    ${recoveryState}
    <div class="cfg-actions">
      <form method="post" action="/app/config/recovery-code">
        <button type="submit" class="btn btn-ghost">${s.recovery || s.freshRecoveryCode ? 'Gerar novo código (invalida o anterior)' : 'Gerar código de recuperação'}</button>
      </form>
    </div>
    <details class="cfg-help">
      <summary>Como funciona</summary>
      <div class="cfg-help-body">
        <p>O código destrava a tela <a href="/app/login/recover">Esqueci a senha</a> pra definir uma senha nova sem estar logado. Gere enquanto você TEM acesso e guarde no 1Password.</p>
      </div>
    </details>
  </div>`;
}
