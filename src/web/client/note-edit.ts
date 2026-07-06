// Client do editor inline de NOTA de conhecimento (/app/notes/<id>) — spec 36 fase 2.
// - title: input borderless (parece texto até hover/focus). Salva por botão + Ctrl/Cmd+Enter.
// - body: textarea markdown + prévia = a própria seção .note-body re-renderizada no reload
//   (aqui só uma prévia leve client-side ao digitar). Salva por botão + Ctrl/Cmd+Enter.
// - tldr: input curto com contador (10-280). Autosave no blur/change.
// - domains: multi-select simples dos 12 canônicos, máx 3. Autosave no change.
// - kind: select dos 7. Autosave no change.
// - Concorrência otimista: expected_updated_at do data-updated-at; 409 → aviso sem sobrescrever.
// - RAJADA: autosave estruturado passa pela save-queue (fila de 1) — mudar kind e domínio
//   em <1s NÃO gera 409 auto-infligido (reenvia com o updated_at fresco da resposta).
// - CSP: zero onclick/onchange inline — tudo via addEventListener neste bundle.

import { appFetch } from './http.js';
import { createSaveQueue, type SaveResult } from './save-queue.js';

const root = document.querySelector<HTMLElement>('.note-edit');

if (root) {
  const noteId = root.dataset.noteId || '';
  let expectedUpdatedAt: number | null = root.dataset.updatedAt ? Number(root.dataset.updatedAt) : null;

  const statusEl = document.querySelector<HTMLElement>('[data-editstatus]');
  const titleInput = root.querySelector<HTMLInputElement>('[data-field="title"]');
  const titleSaveBtn = root.querySelector<HTMLButtonElement>('[data-save="title"]');
  const tldrInput = root.querySelector<HTMLTextAreaElement>('[data-field="tldr"]');
  const tldrCount = root.querySelector<HTMLElement>('[data-tldr-count]');
  const kindSel = root.querySelector<HTMLSelectElement>('[data-field="kind"]');
  const domainsBox = root.querySelector<HTMLElement>('[data-field="domains"]');
  const domainChecks = Array.from(root.querySelectorAll<HTMLInputElement>('[data-domain]'));
  // Corpo/prévia/status ficam num 2º bloco .note-edit (separado pela mídia/grafo local),
  // então buscamos no documento inteiro, não só no root do cabeçalho.
  const bodyArea = document.querySelector<HTMLTextAreaElement>('[data-field="body"]');
  const bodySaveBtn = document.querySelector<HTMLButtonElement>('[data-save="body"]');
  const previewEl = document.querySelector<HTMLElement>('[data-preview]');

  let titleSaved = titleInput?.value ?? '';
  let bodySaved = bodyArea?.value ?? '';

  function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }
  function inline(s: string): string {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
  function renderPreview(md: string): string {
    return md
      .split(/\n{2,}/)
      .map((block) => {
        const b = block.trim();
        if (!b) return '';
        const h = b.match(/^(#{1,3})\s+(.*)$/);
        if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
        return `<p>${inline(b).replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }

  function setStatus(msg: string, cls: 'ok' | 'saving' | 'err' | '') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'note-edit-status' + (cls ? ' ' + cls : '');
  }

  function markDirty(btn: HTMLButtonElement | null, dirty: boolean) {
    if (btn) btn.classList.toggle('dirty', dirty);
  }

  function showReloadPrompt() {
    if (!statusEl || statusEl.querySelector('.note-edit-reload')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'note-edit-reload';
    btn.textContent = 'Recarregar';
    btn.style.marginLeft = '10px';
    btn.addEventListener('click', () => location.reload());
    statusEl.appendChild(btn);
  }

  // POST cru → SaveResult (a fila só entende { ok, updatedAt }). Trata 409/erro
  // aqui pra o aviso aparecer, mas devolve ok=false pra fila parar de reenviar.
  async function doPost(patch: Record<string, unknown>, expected: number | null): Promise<SaveResult> {
    setStatus('Salvando...', 'saving');
    try {
      const res = await appFetch('/app/notes/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: noteId, patch, expected_updated_at: expected }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setStatus('Esta nota foi editada em outro lugar. Recarregue antes de salvar.', 'err');
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
    } catch {
      setStatus('Falha de conexão ao salvar', 'err');
      return { ok: false, updatedAt: null };
    }
  }

  // Fila de rajada pros campos ESTRUTURADOS (tldr/domínios/kind) — coalesce +
  // reenvio com updated_at fresco, matando o 409 auto-infligido.
  const queue = createSaveQueue({
    send: doPost,
    getExpected: () => expectedUpdatedAt,
    setExpected: (v) => { expectedUpdatedAt = v; },
  });

  // Save direto (não-enfileirado) pros campos de TEXTO LIVRE por botão — retorna
  // boolean pro caller marcar o baseline. Também avança expectedUpdatedAt.
  async function saveDirect(patch: Record<string, unknown>): Promise<boolean> {
    const res = await doPost(patch, expectedUpdatedAt);
    if (res.ok && typeof res.updatedAt === 'number') expectedUpdatedAt = res.updatedAt;
    return res.ok;
  }

  // ── tldr: contador + autosave (enfileirado) ──
  function updateTldrCount() {
    if (!tldrInput || !tldrCount) return;
    const n = tldrInput.value.trim().length;
    tldrCount.textContent = `${n}/280`;
    tldrCount.classList.toggle('bad', n < 10 || n > 280);
  }
  tldrInput?.addEventListener('input', updateTldrCount);
  tldrInput?.addEventListener('change', () => {
    const v = (tldrInput.value ?? '').trim();
    if (v.length < 10 || v.length > 280) {
      setStatus('Tldr precisa ter entre 10 e 280 caracteres.', 'err');
      return;
    }
    queue.enqueue({ tldr: v });
  });
  updateTldrCount();

  // ── kind: autosave (enfileirado) ──
  kindSel?.addEventListener('change', () => { queue.enqueue({ kind: kindSel.value }); });

  // ── domains: multi-select máx 3, autosave (enfileirado) ──
  function selectedDomains(): string[] {
    return domainChecks.filter((c) => c.checked).map((c) => c.dataset.domain || '');
  }
  domainChecks.forEach((chk) => {
    chk.addEventListener('change', () => {
      const sel = selectedDomains();
      if (sel.length > 3) {
        chk.checked = false;
        setStatus('Máximo de 3 domínios.', 'err');
        return;
      }
      if (sel.length < 1) {
        chk.checked = true; // não deixa zerar — nota precisa de ≥1 domínio
        setStatus('A nota precisa de ao menos 1 domínio.', 'err');
        return;
      }
      if (domainsBox) domainsBox.classList.toggle('at-max', sel.length >= 3);
      queue.enqueue({ domains: sel });
    });
  });
  if (domainsBox) domainsBox.classList.toggle('at-max', selectedDomains().length >= 3);

  // ── title: botão + Ctrl/Cmd+Enter ──
  async function saveTitle() {
    if (!titleInput) return;
    const v = titleInput.value.trim();
    if (v.length < 1 || v.length > 200) { setStatus('Título deve ter 1-200 caracteres.', 'err'); return; }
    if (await saveDirect({ title: v })) { titleSaved = titleInput.value; markDirty(titleSaveBtn, false); }
  }
  titleSaveBtn?.addEventListener('click', saveTitle);
  titleInput?.addEventListener('input', () => markDirty(titleSaveBtn, titleInput.value !== titleSaved));
  titleInput?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveTitle(); }
  });

  // ── body: botão + Ctrl/Cmd+Enter + prévia ao digitar ──
  async function saveBody() {
    if (!bodyArea) return;
    const v = bodyArea.value.trim();
    if (v.length < 1) { setStatus('O corpo não pode ficar vazio.', 'err'); return; }
    if (await saveDirect({ body: v })) { bodySaved = bodyArea.value; markDirty(bodySaveBtn, false); }
  }
  bodySaveBtn?.addEventListener('click', saveBody);
  bodyArea?.addEventListener('input', () => {
    markDirty(bodySaveBtn, bodyArea.value !== bodySaved);
    if (previewEl) previewEl.innerHTML = renderPreview(bodyArea.value);
  });
  bodyArea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveBody(); }
  });

  // Aviso ao sair com edição de texto livre pendente OU save estruturado em voo.
  window.addEventListener('beforeunload', (e) => {
    const dirtyText = (titleInput?.value ?? '') !== titleSaved || (bodyArea?.value ?? '') !== bodySaved;
    if (dirtyText || queue.isBusy()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ── Menções (spec 62): @autocomplete de contatos + chips + "Criar task desta nota" ──
// Bloco independente do editor de nota (a seção .note-mentions vive fora do .note-edit).
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const mentionsRoot = document.querySelector<HTMLElement>('[data-mentions-editor]');
if (mentionsRoot) {
  const noteId = mentionsRoot.dataset.mentionsEditor || '';
  const chipsBox = mentionsRoot.querySelector<HTMLElement>('[data-mention-chips]');
  const input = mentionsRoot.querySelector<HTMLInputElement>('[data-mention-input]');
  const suggest = mentionsRoot.querySelector<HTMLElement>('[data-mention-suggest]');
  const statusEl = mentionsRoot.querySelector<HTMLElement>('[data-mention-status]');

  function setStatus(msg: string) { if (statusEl) statusEl.textContent = msg; }

  function currentIds(): Set<string> {
    const ids = new Set<string>();
    chipsBox?.querySelectorAll<HTMLElement>('[data-entity-id]').forEach((el) => {
      if (el.dataset.entityId) ids.add(el.dataset.entityId);
    });
    return ids;
  }

  function addChip(entityId: string, label: string) {
    if (!chipsBox) return;
    const span = document.createElement('span');
    span.className = 'mention-chip';
    span.dataset.entityId = entityId;
    span.innerHTML =
      `<a href="/app/contacts/${escHtml(entityId)}">${escHtml(label || entityId)}</a>` +
      `<button type="button" class="mention-chip-remove" data-mention-remove="${escHtml(entityId)}" title="Remover menção" aria-label="Remover menção">×</button>`;
    chipsBox.appendChild(span);
  }

  function hideSuggest() { if (suggest) { suggest.hidden = true; suggest.innerHTML = ''; } }

  async function postMention(body: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await appFetch('/app/notes/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: noteId, patch: {}, ...body }),
      });
      return res.ok;
    } catch { return false; }
  }

  async function addMention(entityId: string, label: string) {
    if (currentIds().has(entityId)) { hideSuggest(); if (input) input.value = ''; return; }
    setStatus('Adicionando...');
    const ok = await postMention({ mentions: [entityId] });
    if (ok) { addChip(entityId, label); setStatus('Menção adicionada.'); }
    else setStatus('Falha ao adicionar menção.');
    if (input) input.value = '';
    hideSuggest();
  }

  async function removeMention(entityId: string, chip: HTMLElement) {
    setStatus('Removendo...');
    const ok = await postMention({ mentions_remove: [entityId] });
    if (ok) { chip.remove(); setStatus('Menção removida.'); }
    else setStatus('Falha ao remover menção.');
  }

  // Remoção de chip (delegação — chips SSR e os adicionados dinamicamente).
  chipsBox?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-mention-remove]');
    if (!btn) return;
    const chip = btn.closest<HTMLElement>('[data-entity-id]');
    const id = btn.dataset.mentionRemove || '';
    if (chip && id) void removeMention(id, chip);
  });

  // @autocomplete: debounce da busca no /app/contacts/search.
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  input?.addEventListener('input', () => {
    const q = (input.value || '').replace(/^@/, '').trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (q.length < 2) { hideSuggest(); return; }
    searchTimer = setTimeout(() => {
      void fetch(`/app/contacts/search?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: any) => {
          if (!suggest) return;
          const results: Array<{ id: string; name?: string }> = (d && Array.isArray(d.results)) ? d.results : [];
          const have = currentIds();
          const items = results.filter((r) => r.id && !have.has(r.id)).slice(0, 8);
          if (items.length === 0) {
            suggest.innerHTML = '<div class="mention-suggest-empty">Nenhum contato encontrado.</div>';
          } else {
            suggest.innerHTML = items.map((r) =>
              `<button type="button" class="mention-suggest-item" data-suggest-id="${escHtml(r.id)}" data-suggest-name="${escHtml(r.name || r.id)}">${escHtml(r.name || r.id)}</button>`
            ).join('');
          }
          suggest.hidden = false;
        })
        .catch(() => hideSuggest());
    }, 220);
  });

  suggest?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-suggest-id]');
    if (!item) return;
    void addMention(item.dataset.suggestId || '', item.dataset.suggestName || '');
  });

  // Fecha o dropdown ao clicar fora.
  document.addEventListener('click', (e) => {
    if (!mentionsRoot.contains(e.target as Node)) hideSuggest();
  });
}

// "Criar task desta nota" (spec 62 §2) — cria a task com origin + menções herdadas.
const createTaskBtn = document.querySelector<HTMLButtonElement>('[data-create-task-from-note]');
if (createTaskBtn) {
  const noteId = createTaskBtn.dataset.createTaskFromNote || '';
  const list = document.querySelector<HTMLElement>('[data-origin-tasks-list]');
  createTaskBtn.addEventListener('click', () => {
    createTaskBtn.disabled = true;
    const original = createTaskBtn.textContent;
    createTaskBtn.textContent = 'Criando...';
    void appFetch('/app/notes/task-from-note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note_id: noteId }),
    })
      .then(async (res) => {
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok || !data.id) throw new Error(data.error || `falha ${res.status}`);
        if (list) {
          const empty = list.querySelector('.note-origin-empty');
          if (empty) empty.remove();
          const a = document.createElement('a');
          a.className = 'note-card';
          a.href = `/app/tasks/${data.id}`;
          a.innerHTML = `<div class="title">${escHtml(document.title)}</div><div class="meta"><span class="badge">open</span></div>`;
          list.insertBefore ? list.insertBefore(a, list.firstChild) : list.appendChild(a);
        }
        window.location.href = `/app/tasks/${data.id}`;
      })
      .catch(() => {
        createTaskBtn.disabled = false;
        createTaskBtn.textContent = original;
      });
  });
}

export {};
