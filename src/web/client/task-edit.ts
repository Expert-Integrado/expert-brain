// Client do editor inline de task (/app/tasks/<id>) — spec 36, fase 1.
// - Autosave em status/prioridade/prazo (eventos `change` discretos dos selects
//   e do datetime-local). Sem debounce: são pickers, não texto contínuo.
// - Título e corpo salvam por botão "Salvar" + atalho Ctrl/Cmd+Enter. Texto livre
//   NÃO autosalva no meio da digitação (spec: destrutivo).
// - Concorrência otimista: reenvia o `data-updated-at` da página como
//   expected_updated_at; em 409 mostra "editada em outro lugar, recarregue" e NÃO
//   sobrescreve. A cada save bem-sucedido, atualiza o expected_updated_at local.
// - Prévia de markdown client-side leve (sem puxar `marked`), atualizada ao digitar.
// - CSP: zero onclick/onchange inline — tudo via addEventListener neste bundle.

import { appFetch } from './http.js';
import { createSaveQueue, type SaveResult } from './save-queue.js';

const root = document.querySelector<HTMLElement>('.task-edit');

if (root) {
  const taskId = root.dataset.taskId || '';
  // updated_at que a página carregou → base do versionamento otimista. Atualiza a
  // cada save OK com o updated_at devolvido pelo servidor.
  let expectedUpdatedAt: number | null = root.dataset.updatedAt ? Number(root.dataset.updatedAt) : null;

  const statusEl = document.querySelector<HTMLElement>('[data-editstatus]');
  const titleInput = root.querySelector<HTMLInputElement>('[data-field="title"]');
  const bodyArea = root.querySelector<HTMLTextAreaElement>('[data-field="body"]');
  const previewEl = root.querySelector<HTMLElement>('[data-preview]');
  const statusSel = root.querySelector<HTMLSelectElement>('[data-field="status"]');
  const prioSel = root.querySelector<HTMLSelectElement>('[data-field="priority"]');
  const dueDateInput = root.querySelector<HTMLInputElement>('[data-field="due-date"]');
  const dueTimeInput = root.querySelector<HTMLInputElement>('[data-field="due-time"]');
  const dueClearBtn = root.querySelector<HTMLButtonElement>('[data-clear="due"]');
  const titleSaveBtn = root.querySelector<HTMLButtonElement>('[data-save="title"]');
  const bodySaveBtn = root.querySelector<HTMLButtonElement>('[data-save="body"]');

  // Baselines pra detectar "dirty" (mudança não salva) em texto livre.
  let titleSaved = titleInput?.value ?? '';
  let bodySaved = bodyArea?.value ?? '';

  function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }

  // Prévia markdown leve: escapa tudo e aplica só heading/negrito/itálico/código
  // inline + parágrafos. Não é o renderer do servidor (que resolve wikilinks) — é
  // só um feedback visual enquanto edita. O corpo salvo é re-renderizado no reload.
  function renderPreview(md: string): string {
    return md
      .split(/\n{2,}/)
      .map((block) => {
        const b = block.trim();
        if (!b) return '';
        const h = b.match(/^(#{1,3})\s+(.*)$/);
        if (h) {
          const level = h[1].length;
          return `<h${level}>${inline(h[2])}</h${level}>`;
        }
        return `<p>${inline(b).replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }
  function inline(s: string): string {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  function setStatus(msg: string, cls: 'ok' | 'saving' | 'err' | '') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'task-edit-status' + (cls ? ' ' + cls : '');
  }

  function markDirty(btn: HTMLButtonElement | null, dirty: boolean) {
    if (btn) btn.classList.toggle('dirty', dirty);
  }

  function anyDirty(): boolean {
    return (titleInput?.value ?? '') !== titleSaved || (bodyArea?.value ?? '') !== bodySaved;
  }

  // POST cru → SaveResult. Trata 409/erro com feedback; devolve { ok, updatedAt }
  // pra a fila (rajada) e pro save() por botão saberem se avançar a base.
  async function doPost(patch: Record<string, unknown>, expected: number | null): Promise<SaveResult> {
    setStatus('Salvando...', 'saving');
    try {
      const res = await appFetch('/app/tasks/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: taskId, patch, expected_updated_at: expected }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setStatus('Esta task foi editada em outro lugar. Recarregue antes de salvar.', 'err');
        showReloadPrompt();
        return { ok: false, updatedAt: null };
      }
      if (!res.ok) {
        setStatus('Erro: ' + (data && (data as any).error ? (data as any).error : res.status), 'err');
        return { ok: false, updatedAt: null };
      }
      setStatus('Salvo', 'ok');
      const ua = data && typeof (data as any).updated_at === 'number' ? (data as any).updated_at : null;
      return { ok: true, updatedAt: ua };
    } catch (err) {
      // appFetch já redireciona em 401; aqui é falha de rede.
      setStatus('Falha de conexão ao salvar', 'err');
      return { ok: false, updatedAt: null };
    }
  }

  // Fila de rajada pros campos ESTRUTURADOS (status/prioridade/prazo): mudar 2
  // selects em <1s vira cadeia sequencial com updated_at fresco → sem 409 auto-infligido.
  const queue = createSaveQueue({
    send: doPost,
    getExpected: () => expectedUpdatedAt,
    setExpected: (v) => { expectedUpdatedAt = v; },
  });

  // Save direto (texto livre por botão): retorna boolean pro caller marcar baseline.
  async function save(patch: Record<string, unknown>): Promise<boolean> {
    const res = await doPost(patch, expectedUpdatedAt);
    if (res.ok && typeof res.updatedAt === 'number') expectedUpdatedAt = res.updatedAt;
    return res.ok;
  }

  // Aviso de conflito: injeta um botão "Recarregar" após o status.
  function showReloadPrompt() {
    if (!statusEl || statusEl.querySelector('.task-edit-reload')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'task-d-btn task-edit-reload';
    btn.textContent = 'Recarregar';
    btn.style.marginLeft = '10px';
    btn.addEventListener('click', () => location.reload());
    statusEl.appendChild(btn);
  }

  // ── Autosave: status / prioridade / prazo (enfileirado — rajada) ──
  statusSel?.addEventListener('change', () => { queue.enqueue({ status: statusSel.value }); });

  prioSel?.addEventListener('change', () => {
    // "" = sem prioridade → null; senão inteiro 1-4.
    const v = prioSel.value === '' ? null : Number(prioSel.value);
    queue.enqueue({ priority: v });
  });

  // Prazo = DATA + HORA separados (hora opcional — spec 36 fase 2). Data vazia →
  // null (limpa). Só data → "2026-07-10" (servidor trata como fim do dia). Data +
  // hora → "2026-07-10T14:00" (servidor reinterpreta em BRT).
  function composeDue(): string | null {
    const d = (dueDateInput?.value ?? '').trim();
    if (!d) return null;
    const t = (dueTimeInput?.value ?? '').trim();
    return t ? `${d}T${t}` : d;
  }
  const saveDue = () => { queue.enqueue({ due: composeDue() }); };
  dueDateInput?.addEventListener('change', saveDue);
  dueTimeInput?.addEventListener('change', saveDue);

  dueClearBtn?.addEventListener('click', () => {
    if (dueDateInput) dueDateInput.value = '';
    if (dueTimeInput) dueTimeInput.value = '';
    queue.enqueue({ due: null });
  });

  // ── Save por botão: título ──
  async function saveTitle() {
    if (!titleInput) return;
    const v = titleInput.value.trim();
    if (v.length < 1) { setStatus('Título não pode ficar vazio', 'err'); return; }
    if (await save({ title: v })) { titleSaved = titleInput.value; markDirty(titleSaveBtn, false); }
  }
  titleSaveBtn?.addEventListener('click', saveTitle);
  titleInput?.addEventListener('input', () => markDirty(titleSaveBtn, titleInput.value !== titleSaved));
  titleInput?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveTitle(); }
  });

  // ── Save por botão: corpo/descrição ──
  async function saveBody() {
    if (!bodyArea) return;
    if (await save({ body: bodyArea.value })) { bodySaved = bodyArea.value; markDirty(bodySaveBtn, false); }
  }
  bodySaveBtn?.addEventListener('click', saveBody);
  bodyArea?.addEventListener('input', () => {
    markDirty(bodySaveBtn, bodyArea.value !== bodySaved);
    if (previewEl) previewEl.innerHTML = renderPreview(bodyArea.value);
  });
  bodyArea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveBody(); }
  });

  // Aviso ao sair com edição de texto pendente (só título/corpo — estruturados
  // já autosalvaram).
  window.addEventListener('beforeunload', (e) => {
    if (anyDirty() || queue.isBusy()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ── Compartilhamento público (spec 33) ──
// Gera/renova (POST /app/tasks/share) e revoga (POST /app/tasks/unshare) o link
// /s/<token>. O link só chega uma vez na resposta — mostra num input read-only pra
// copiar. CSP: tudo via addEventListener neste bundle (zero inline).
const shareRoot = document.querySelector<HTMLElement>('.task-share');
if (shareRoot) {
  const taskId = shareRoot.dataset.taskId || '';
  const genBtn = shareRoot.querySelector<HTMLButtonElement>('[data-share-generate]');
  const revokeBtn = shareRoot.querySelector<HTMLButtonElement>('[data-share-revoke]');
  const daysInput = shareRoot.querySelector<HTMLInputElement>('[data-share-days]');
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
    // Se já está compartilhada e viva, "Gerar novo link" renova (troca o token). O
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
      const res = await appFetch('/app/tasks/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: taskId, expires_days: days, renew: alreadyShared }),
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
    if (!confirm('Revogar o link público? Quem tiver o link deixa de conseguir abrir a task.')) return;
    setShareStatus('Revogando...', 'saving');
    try {
      const res = await appFetch('/app/tasks/unshare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: taskId }),
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
      if (stateEl) stateEl.textContent = 'Esta task não está compartilhada. Gere um link público read-only pra enviar a alguém sem conta.';
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

export {};
