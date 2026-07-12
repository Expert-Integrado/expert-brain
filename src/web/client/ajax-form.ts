// Progressive enhancement dos forms de admin (spec 91-experiencia-premium/94).
// Form marcado com data-ajax-form: o submit vira fetch (appFetch manda
// accept: application/json, então o servidor responde o erro como JSON
// { ok:false, error, field } via formError). Erro com field vira mensagem
// inline no campo; sem field vira toast — em ambos os casos o que o usuário
// digitou fica na tela. Sucesso segue o redirect do servidor (mesmo destino
// do form nativo). Sem JS o form continua funcionando: o servidor cai no
// fallback 303 + ?error= (banner).

import { appFetch } from './http.js';
import { toast } from './toast.js';

function clearErrors(form: HTMLFormElement): void {
  form.querySelectorAll('.field-error').forEach((n) => n.remove());
  form.querySelectorAll('.field-invalid').forEach((n) => n.classList.remove('field-invalid'));
}

function showFieldError(form: HTMLFormElement, field: string, message: string): boolean {
  const input = form.querySelector<HTMLElement>(`[name="${CSS.escape(field)}"]`);
  if (!input) return false;
  input.classList.add('field-invalid');
  const p = document.createElement('p');
  p.className = 'field-error';
  p.setAttribute('role', 'alert');
  p.textContent = message;
  input.insertAdjacentElement('afterend', p);
  if (typeof (input as HTMLInputElement).focus === 'function') (input as HTMLInputElement).focus();
  return true;
}

export function wireAjaxForms(): void {
  document.addEventListener('submit', (e) => {
    // Outro listener (ex.: confirm() do config-script) pode ter cancelado.
    if (e.defaultPrevented) return;
    const form = (e.target as HTMLElement | null)?.closest?.('form[data-ajax-form]') as HTMLFormElement | null;
    if (!form) return;
    e.preventDefault();
    clearErrors(form);
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"], input[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    appFetch(form.action, { method: 'POST', body: new FormData(form) })
      .then(async (res) => {
        if (res.ok) {
          // Redirect seguido pelo fetch → navega pro destino final (res.url perde
          // o #anchor do Location; a seção certa reabre via ?saved=).
          if (res.redirected) window.location.href = res.url;
          else window.location.reload();
          return;
        }
        let payload: { error?: string; field?: string | null } | null = null;
        try { payload = await res.json(); } catch { /* corpo não-JSON (5xx cru) */ }
        const msg = payload?.error || `Erro ao salvar (HTTP ${res.status})`;
        if (!(payload?.field && showFieldError(form, payload.field, msg))) toast(msg, 'error');
        if (submitBtn) submitBtn.disabled = false;
      })
      .catch(() => {
        // appFetch já redirecionou pro login no 401; falha de rede: reabilita.
        if (submitBtn) submitBtn.disabled = false;
      });
  });
}
