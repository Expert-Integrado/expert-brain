// Seletor único de visibilidade (spec 60-ux-reforma/65) — detalhe de TASK e de NOTA.
// Evolução do antigo share-ui.ts: além de gerar/revogar o link público, gerencia o
// radiogroup Privado / Normal / Link público com transições encadeadas:
//   Normal→Privado   POST private=true (o server revoga qualquer link no mesmo write)
//   Privado→Normal   POST private=false
//   Link→Privado     confirm → POST private=true (derruba o link junto)
//   Link→Normal      confirm → POST unshare
//   Normal→Link      só abre o painel; o link nasce no clique em "Gerar link"
//   Privado→Link     confirm → POST private=false e já tenta gerar; se a geração
//                    falhar, para em Normal (fail-safe pro estado MENOS exposto)
// ZERO endpoint novo — reusa POST {endpoint}/private, /share e /unshare existentes.
// O link só chega uma vez na resposta (o banco guarda só o hash) — mostrado num
// input read-only pra copiar. CSP: tudo via addEventListener (zero inline).

import { appFetch } from './http.js';
import { confirmModal } from './confirm-modal.js';

type VisState = 'private' | 'normal' | 'link';

const GENERATE_HINT = 'Gere um link público read-only pra enviar a alguém sem conta.';

export function initVisibilityUi(): void {
  const rootMaybe = document.querySelector<HTMLElement>('[data-visibility]');
  if (!rootMaybe) return;
  const root: HTMLElement = rootMaybe;

  const id = root.dataset.id || '';
  const endpoint = root.dataset.shareEndpoint || '/app/tasks';
  const privateAction = root.dataset.privateAction || `${endpoint}/private`;
  const kindLabel = root.dataset.kind === 'note' ? 'nota' : 'task';

  const radios = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="visibility"]'));
  const panel = root.querySelector<HTMLElement>('[data-vis-panel]');
  const genBtn = root.querySelector<HTMLButtonElement>('[data-share-generate]');
  const revokeBtn = root.querySelector<HTMLButtonElement>('[data-share-revoke]');
  const daysInput = root.querySelector<HTMLInputElement>('[data-share-days]');
  const mediaCheck = root.querySelector<HTMLInputElement>('[data-share-media]');
  const linkWrap = root.querySelector<HTMLElement>('[data-share-link]');
  const urlInput = root.querySelector<HTMLInputElement>('[data-share-url]');
  const copyBtn = root.querySelector<HTMLButtonElement>('[data-share-copy]');
  const stateEl = root.querySelector<HTMLElement>('[data-share-state]');
  const statusEl = root.querySelector<HTMLElement>('[data-share-status]');

  let state: VisState = (root.dataset.state as VisState) || 'normal';
  let busy = false; // uma transição por vez — POST em andamento ignora cliques

  function setStatus(msg: string, cls: 'ok' | 'err' | 'saving' | ''): void {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'task-share-status' + (cls ? ' ' + cls : '');
  }

  // Marca o radio + a moldura .selected. null = re-sincroniza com o estado REAL
  // (usado pra desfazer a seleção quando o usuário cancela o confirm ou o POST falha).
  function syncRadios(intent: VisState | null): void {
    const v = intent ?? state;
    for (const r of radios) {
      r.checked = r.value === v;
      r.closest('.vis-opt')?.classList.toggle('selected', r.value === v);
    }
  }

  function setPanelVisible(v: boolean): void {
    if (panel) panel.hidden = !v;
  }

  function setState(next: VisState): void {
    state = next;
    root.dataset.state = next;
    syncRadios(null);
  }

  function resetShareUiToUnshared(): void {
    root.dataset.shared = '0';
    if (revokeBtn) revokeBtn.hidden = true;
    if (linkWrap) linkWrap.hidden = true;
    if (urlInput) urlInput.value = '';
    if (genBtn) genBtn.textContent = 'Gerar link';
    if (stateEl) stateEl.textContent = GENERATE_HINT;
  }

  async function setPrivate(makePrivate: boolean): Promise<boolean> {
    setStatus(makePrivate ? 'Tornando privada...' : 'Saindo do modo privado...', 'saving');
    try {
      const res = await appFetch(privateAction, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // O endpoint de nota ignora `id` (vem do path) — mandar sempre simplifica.
        body: JSON.stringify({ id, private: makePrivate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('Erro: ' + ((data as { error?: string }).error || res.status), 'err');
        return false;
      }
      return true;
    } catch {
      setStatus('Falha de conexão.', 'err');
      return false;
    }
  }

  async function generate(): Promise<boolean> {
    // Já compartilhado e vivo? "Gerar novo link" renova (troca o token) — o dono
    // clicou explicitamente pra (re)ver o link, então sempre pedimos renew.
    const alreadyShared = root.dataset.shared === '1';
    const days = Number(daysInput?.value || '30');
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setStatus('Validade deve ser um inteiro entre 1 e 365 dias.', 'err');
      return false;
    }
    setStatus('Gerando link...', 'saving');
    try {
      const res = await appFetch(`${endpoint}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          expires_days: days,
          renew: alreadyShared,
          include_media: mediaCheck?.checked === true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('Erro: ' + ((data as { error?: string }).error || res.status), 'err');
        return false;
      }
      const url = (data as { url?: string }).url;
      const expiresBrt = (data as { expires_brt?: string }).expires_brt;
      if (url && urlInput && linkWrap) {
        urlInput.value = url;
        linkWrap.hidden = false;
        urlInput.focus();
        urlInput.select();
      }
      root.dataset.shared = '1';
      if (revokeBtn) revokeBtn.hidden = false;
      if (genBtn) genBtn.textContent = 'Gerar novo link';
      if (stateEl && expiresBrt) {
        stateEl.innerHTML =
          'Link público ativo, válido até <strong>' + expiresBrt.replace(/[<>&]/g, '') +
          '</strong>. Copie agora — ele não é exibido de novo.';
      }
      setState('link');
      setPanelVisible(true);
      setStatus('Link gerado. Copie e envie.', 'ok');
      return true;
    } catch {
      setStatus('Falha de conexão.', 'err');
      return false;
    }
  }

  // Revogação SEM confirm — os chamadores decidem se confirmam (o botão Revogar
  // confirma; a transição Link→Normal confirma antes com texto próprio).
  async function doRevoke(): Promise<boolean> {
    setStatus('Revogando...', 'saving');
    try {
      const res = await appFetch(`${endpoint}/unshare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('Erro: ' + ((data as { error?: string }).error || res.status), 'err');
        return false;
      }
      resetShareUiToUnshared();
      return true;
    } catch {
      setStatus('Falha de conexão.', 'err');
      return false;
    }
  }

  async function copyLink(): Promise<void> {
    if (!urlInput || !urlInput.value) return;
    try {
      await navigator.clipboard.writeText(urlInput.value);
      setStatus('Link copiado.', 'ok');
    } catch {
      urlInput.focus();
      urlInput.select();
      setStatus('Selecione e copie manualmente (Ctrl+C).', '');
    }
  }

  async function onSelect(next: VisState): Promise<void> {
    if (busy) {
      syncRadios(null);
      return;
    }
    if (next === state) {
      setPanelVisible(next === 'link');
      return;
    }
    busy = true;
    try {
      if (next === 'private') {
        if (state === 'link' && root.dataset.shared === '1') {
          if (!(await confirmModal({ title: `Tornar a ${kindLabel} privada?`, body: 'Isso revoga o link público. Quem tiver o link deixa de conseguir abrir.', verb: 'Tornar privada' }))) {
            syncRadios(null);
            return;
          }
        }
        if (!(await setPrivate(true))) {
          syncRadios(null);
          return;
        }
        // Marcar privada revoga qualquer link na MESMA escrita do server.
        resetShareUiToUnshared();
        setState('private');
        setPanelVisible(false);
        setStatus(`A ${kindLabel} agora é privada.`, 'ok');
        return;
      }
      if (next === 'normal') {
        if (state === 'link' && root.dataset.shared === '1') {
          if (!(await confirmModal({ title: 'Voltar pro normal?', body: 'Isso revoga o link público. Quem tiver o link deixa de conseguir abrir.', verb: 'Revogar link' }))) {
            syncRadios(null);
            return;
          }
          if (!(await doRevoke())) {
            syncRadios(null);
            return;
          }
          setState('normal');
          setPanelVisible(false);
          setStatus('Link revogado.', 'ok');
          return;
        }
        // vindo de privado (ou de "link" sem share vivo — ex. expirado e revogado)
        if (!(await setPrivate(false))) {
          syncRadios(null);
          return;
        }
        setState('normal');
        setPanelVisible(false);
        setStatus(`A ${kindLabel} voltou pro modo normal.`, 'ok');
        return;
      }
      // next === 'link'
      if (state === 'private') {
        if (!(await confirmModal({ title: 'Criar link público?', body: `Isso tira a ${kindLabel} do modo privado.`, verb: 'Criar link', danger: false }))) {
          syncRadios(null);
          return;
        }
        if (!(await setPrivate(false))) {
          syncRadios(null);
          return;
        }
        // Fail-safe: já saiu do privado; se a geração falhar, fica em Normal.
        setState('normal');
        syncRadios('link');
        setPanelVisible(true);
        if (!(await generate())) syncRadios(null);
        return;
      }
      // vindo de normal: o radio marca a INTENÇÃO; o estado real só muda quando
      // o link for gerado no botão do painel.
      setPanelVisible(true);
    } finally {
      busy = false;
    }
  }

  radios.forEach((r) =>
    r.addEventListener('change', () => {
      if (r.checked) void onSelect(r.value as VisState);
    })
  );
  genBtn?.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    void generate().finally(() => {
      busy = false;
    });
  });
  revokeBtn?.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    void (async () => {
      const ok = await confirmModal({ title: 'Revogar o link público?', body: 'Quem tiver o link deixa de conseguir abrir.', verb: 'Revogar' });
      if (!ok) return;
      if (await doRevoke()) {
        setState('normal');
        setPanelVisible(false);
        setStatus('Link revogado.', 'ok');
      }
    })()
      .finally(() => {
        busy = false;
      });
  });
  copyBtn?.addEventListener('click', () => void copyLink());
}
