// Wiring compartilhado da seção "Compartilhamento público" (spec 33) — usado no
// detalhe de TASK (task-edit.ts) e no detalhe de NOTA (note-edit.ts). O endpoint
// vem do data-share-endpoint da seção ('/app/tasks' ou '/app/notes' — aliases dos
// mesmos handlers no servidor). O link só chega uma vez na resposta — mostra num
// input read-only pra copiar. CSP: tudo via addEventListener (zero inline).

import { appFetch } from './http.js';

export function initShareUi(): void {
  const shareRoot = document.querySelector<HTMLElement>('.task-share');
  if (!shareRoot) return;

  const itemId = shareRoot.dataset.taskId || shareRoot.dataset.noteId || '';
  const endpoint = shareRoot.dataset.shareEndpoint || '/app/tasks';
  const genBtn = shareRoot.querySelector<HTMLButtonElement>('[data-share-generate]');
  const revokeBtn = shareRoot.querySelector<HTMLButtonElement>('[data-share-revoke]');
  const daysInput = shareRoot.querySelector<HTMLInputElement>('[data-share-days]');
  const mediaCheck = shareRoot.querySelector<HTMLInputElement>('[data-share-media]');
  const linkWrap = shareRoot.querySelector<HTMLElement>('[data-share-link]');
  const urlInput = shareRoot.querySelector<HTMLInputElement>('[data-share-url]');
  const copyBtn = shareRoot.querySelector<HTMLButtonElement>('[data-share-copy]');
  const stateEl = shareRoot.querySelector<HTMLElement>('[data-share-state]');
  const statusEl = shareRoot.querySelector<HTMLElement>('[data-share-status]');

  function setShareStatus(msg: string, cls: 'ok' | 'err' | 'saving' | '') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'task-share-status' + (cls ? ' ' + cls : '');
  }

  async function generate() {
    // Se já está compartilhado e vivo, "Gerar novo link" renova (troca o token). O
    // servidor devolve already_shared só quando renew é falso E há link vivo; como o
    // dono clicou explicitamente pra (re)gerar e ver o link, sempre pedimos renew.
    const alreadyShared = shareRoot!.dataset.shared === '1';
    const days = Number(daysInput?.value || '30');
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setShareStatus('Validade deve ser um inteiro entre 1 e 365 dias.', 'err');
      return;
    }
    setShareStatus('Gerando link...', 'saving');
    try {
      const res = await appFetch(`${endpoint}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: itemId,
          expires_days: days,
          renew: alreadyShared,
          include_media: mediaCheck?.checked === true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setShareStatus('Erro: ' + ((data as any).error || res.status), 'err');
        return;
      }
      const url = (data as any).url as string | undefined;
      const expiresBrt = (data as any).expires_brt as string | undefined;
      if (url && urlInput && linkWrap) {
        urlInput.value = url;
        linkWrap.hidden = false;
        urlInput.focus();
        urlInput.select();
      }
      shareRoot!.dataset.shared = '1';
      if (revokeBtn) revokeBtn.hidden = false;
      if (genBtn) genBtn.textContent = 'Gerar novo link';
      if (stateEl && expiresBrt) {
        stateEl.innerHTML =
          'Link público ativo, válido até <strong>' + expiresBrt.replace(/[<>&]/g, '') +
          '</strong>. Copie agora — ele não é exibido de novo.';
      }
      setShareStatus('Link gerado. Copie e envie.', 'ok');
    } catch {
      setShareStatus('Falha de conexão.', 'err');
    }
  }

  async function revoke() {
    if (!confirm('Revogar o link público? Quem tiver o link deixa de conseguir abrir.')) return;
    setShareStatus('Revogando...', 'saving');
    try {
      const res = await appFetch(`${endpoint}/unshare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setShareStatus('Erro: ' + ((data as any).error || res.status), 'err');
        return;
      }
      shareRoot!.dataset.shared = '0';
      if (revokeBtn) revokeBtn.hidden = true;
      if (linkWrap) linkWrap.hidden = true;
      if (urlInput) urlInput.value = '';
      if (genBtn) genBtn.textContent = 'Compartilhar';
      if (stateEl) stateEl.textContent = 'Não está compartilhado. Gere um link público read-only pra enviar a alguém sem conta.';
      setShareStatus('Link revogado.', 'ok');
    } catch {
      setShareStatus('Falha de conexão.', 'err');
    }
  }

  async function copyLink() {
    if (!urlInput || !urlInput.value) return;
    try {
      await navigator.clipboard.writeText(urlInput.value);
      setShareStatus('Link copiado.', 'ok');
    } catch {
      urlInput.focus();
      urlInput.select();
      setShareStatus('Selecione e copie manualmente (Ctrl+C).', '');
    }
  }

  genBtn?.addEventListener('click', generate);
  revokeBtn?.addEventListener('click', revoke);
  copyBtn?.addEventListener('click', copyLink);
}
