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
import { initShareUi } from './share-ui.js';

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
  const columnSel = root.querySelector<HTMLSelectElement>('[data-field="column"]');
  const projectSel = root.querySelector<HTMLSelectElement>('[data-field="project"]');
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

  // ── Coluna (spec 52): substitui o antigo select de "Status" — mais granular,
  // espelha a interação de drag&drop do board (spec 51). Muda via POST
  // /app/tasks/move (não /app/tasks/update): o servidor deriva status+completed_at
  // da categoria da coluna. Fora da fila de rajada (endpoint diferente) — atualiza
  // expectedUpdatedAt direto na resposta.
  columnSel?.addEventListener('change', async () => {
    const columnId = columnSel.value;
    if (!columnId) return;
    setStatus('Salvando...', 'saving');
    try {
      const res = await appFetch('/app/tasks/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: taskId, column_id: columnId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('Erro: ' + (data && (data as any).error ? (data as any).error : res.status), 'err');
        return;
      }
      if (typeof (data as any).updated_at === 'number') expectedUpdatedAt = (data as any).updated_at;
      setStatus('Salvo', 'ok');
    } catch {
      setStatus('Falha de conexão ao salvar', 'err');
    }
  });

  // ── Autosave: projeto/pasta (spec 58) — enfileirado (rajada) via /app/tasks/update.
  // "" = Sem projeto → project_id null; senão o id do projeto. Só ids de projetos
  // ativos aparecem no select; o servidor valida (arquivado/inexistente → erro).
  projectSel?.addEventListener('change', () => {
    queue.enqueue({ project_id: projectSel.value === '' ? null : projectSel.value });
  });

  // ── Autosave: prioridade / prazo (enfileirado — rajada) ──
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

  // ── Tags (spec 52): editor de chips na sidebar. Full-array replace a cada
  // mudança, na MESMA fila de rajada dos campos estruturados — o servidor
  // preserva as tags reservadas dedupe:* automaticamente (replaceTaskTagsPreservingDedupe).
  const tagsEditor = document.querySelector<HTMLElement>('[data-tags-editor]');
  if (tagsEditor) {
    let tags: string[] = [];
    try { tags = JSON.parse(tagsEditor.dataset.tags || '[]'); } catch { tags = []; }
    const tagsInput = tagsEditor.querySelector<HTMLInputElement>('[data-tags-input]');

    function renderTagChips() {
      tagsEditor!.querySelectorAll('.task-tag-chip').forEach((el) => el.remove());
      for (const t of tags) {
        const chip = document.createElement('span');
        chip.className = 'task-tag-chip';
        chip.textContent = t;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'task-tag-remove';
        rm.textContent = '×';
        rm.setAttribute('aria-label', `Remover tag ${t}`);
        rm.addEventListener('click', () => {
          tags = tags.filter((x) => x !== t);
          renderTagChips();
          queue.enqueue({ tags: [...tags] });
        });
        chip.appendChild(rm);
        tagsEditor!.insertBefore(chip, tagsInput ?? null);
      }
    }
    renderTagChips();

    tagsInput?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = tagsInput.value.trim().toLowerCase().slice(0, 60);
      tagsInput.value = '';
      if (!v || tags.includes(v)) return;
      tags.push(v);
      renderTagChips();
      queue.enqueue({ tags: [...tags] });
    });
  }

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
// Wiring extraído pro módulo compartilhado (share-ui.ts) — a mesma seção existe no
// detalhe de NOTA (note-edit.ts). O endpoint vem do data-share-endpoint da seção.
initShareUi();

export {};
