// Client do editor inline de task (/app/tasks/<id>) — spec 36, fase 1.
// - Autosave em status/prioridade/prazo (eventos `change` discretos dos selects
//   e do datetime-local). Sem debounce: são pickers, não texto contínuo.
// - Título: textarea de 1 linha com auto-grow via JS (cresce com o conteúdo,
//   título longo nunca corta/colide com "Salvar"). Salva por botão + Enter (sem
//   quebra de linha); Esc cancela e volta pro valor salvo. Texto livre NÃO
//   autosalva no meio da digitação (spec: destrutivo).
// - Descrição: campo único (spec 74) — LEITURA por padrão (prévia + botão "Editar");
//   clique troca pra EDIÇÃO (textarea + Salvar/Cancelar). Ctrl/Cmd+Enter salva, Esc
//   cancela. Sem live-preview durante a digitação (mesma decisão do note-edit.ts).
// - Responsáveis (spec 74): popover num <details> nativo (abre/fecha sem JS); o
//   submit do form de checkboxes é interceptado por fetch pra atualizar os dots
//   sem reload, na MESMA rota POST /app/tasks/assignees de sempre.
// - Concorrência otimista: reenvia o `data-updated-at` da página como
//   expected_updated_at; em 409 mostra "editada em outro lugar, recarregue" e NÃO
//   sobrescreve. A cada save bem-sucedido, atualiza o expected_updated_at local.
// - CSP: zero onclick/onchange inline — tudo via addEventListener neste bundle.

import { appFetch } from './http.js';
import { createSaveQueue, type SaveResult } from './save-queue.js';
import { initVisibilityUi } from './visibility-ui.js';
import { assigneeDotsHtml, type AssigneeDot } from '../../util/task-badges.js';

const root = document.querySelector<HTMLElement>('.task-edit');

if (root) {
  const taskId = root.dataset.taskId || '';
  // updated_at que a página carregou → base do versionamento otimista. Atualiza a
  // cada save OK com o updated_at devolvido pelo servidor.
  let expectedUpdatedAt: number | null = root.dataset.updatedAt ? Number(root.dataset.updatedAt) : null;

  const statusEl = document.querySelector<HTMLElement>('[data-editstatus]');
  const titleInput = root.querySelector<HTMLTextAreaElement>('[data-field="title"]');
  const bodyViewEl = root.querySelector<HTMLElement>('[data-bodyview]');
  const bodyEditEl = root.querySelector<HTMLElement>('[data-bodyedit]');
  const bodyArea = root.querySelector<HTMLTextAreaElement>('[data-field="body"]');
  const bodyCancelBtn = root.querySelector<HTMLButtonElement>('[data-cancel-body]');
  const previewEl = root.querySelector<HTMLElement>('[data-preview]');
  const projectSel = root.querySelector<HTMLSelectElement>('[data-field="project"]');
  const prioSel = root.querySelector<HTMLSelectElement>('[data-field="priority"]');
  const dueDateInput = root.querySelector<HTMLInputElement>('[data-field="due-date"]');
  const dueTimeInput = root.querySelector<HTMLInputElement>('[data-field="due-time"]');
  const dueClearBtn = root.querySelector<HTMLButtonElement>('[data-clear="due"]');
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

  // ── Funil de status (10/07/2026): substitui o select "Coluna" da sidebar.
  // Clique numa etapa → POST /app/tasks/move (o servidor deriva
  // status+completed_at da categoria da coluna) e repinta a barra sem reload:
  // reached = etapa atual + anteriores (ordem do DOM = ordem do board). Fora da
  // fila de rajada (endpoint diferente) — atualiza expectedUpdatedAt direto.
  const funnelEl = document.querySelector<HTMLElement>('[data-funnel]');
  function paintFunnel(currentId: string): void {
    if (!funnelEl) return;
    const steps = Array.from(funnelEl.querySelectorAll<HTMLButtonElement>('[data-funnel-col]'));
    const idx = steps.findIndex((s) => s.dataset.funnelCol === currentId);
    steps.forEach((s, i) => {
      s.classList.toggle('current', i === idx);
      s.classList.toggle('reached', idx >= 0 && i <= idx);
    });
    // Se a task estava numa coluna arquivada (etapa extra desabilitada no fim),
    // mover pra uma ativa resolve o drift — a etapa fantasma some.
    funnelEl.querySelector('.task-funnel-step.archived')?.remove();
  }
  funnelEl?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-funnel-col]');
    if (!btn || btn.disabled) return;
    const columnId = btn.dataset.funnelCol || '';
    if (!columnId || btn.classList.contains('current')) return;
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
      paintFunnel(columnId);
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

  // ── Título: clica-e-edita, sem botão (10/07/2026) — Enter OU blur salvam
  // quando o valor mudou; Esc reverte. Vazio não salva.
  async function saveTitle() {
    if (!titleInput) return;
    const v = titleInput.value.trim();
    if (v.length < 1) { setStatus('Título não pode ficar vazio', 'err'); return; }
    if (await save({ title: v })) { titleSaved = titleInput.value; }
  }
  titleInput?.addEventListener('blur', () => {
    if (titleInput.value !== titleSaved) void saveTitle();
  });
  // Textarea de 1 linha: cresce com o conteúdo (título nunca corta) e nunca
  // aceita quebra de linha — Enter salva, \n de paste vira espaço.
  function fitTitle() {
    if (!titleInput) return;
    if (titleInput.value.includes('\n')) titleInput.value = titleInput.value.replace(/\n+/g, ' ');
    titleInput.style.height = 'auto';
    // border-box: scrollHeight não inclui as bordas — soma (offsetHeight - clientHeight)
    // pra última linha não ficar 2px clipada pelo overflow:hidden.
    titleInput.style.height = `${titleInput.scrollHeight + titleInput.offsetHeight - titleInput.clientHeight}px`;
  }
  fitTitle();
  titleInput?.addEventListener('input', fitTitle);
  titleInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (titleInput.value !== titleSaved) saveTitle(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      titleInput.value = titleSaved;
      fitTitle();
      titleInput.blur();
    }
  });

  // ── Descrição: campo único (spec 74) — LEITURA (prévia + Editar) ↔ EDIÇÃO
  // (textarea + Salvar/Cancelar). Sem live-preview durante a digitação. Delegado
  // (não um forEach fixo nos triggers do load): o placeholder "Sem descrição" pode
  // ser recriado dinamicamente depois de salvar uma descrição vazia.
  function enterBodyEdit() {
    if (!bodyArea || !bodyViewEl || !bodyEditEl) return;
    bodyArea.value = bodySaved;
    bodyViewEl.hidden = true;
    bodyEditEl.hidden = false;
    bodyArea.focus();
  }
  function exitBodyEdit() {
    if (!bodyViewEl || !bodyEditEl) return;
    bodyEditEl.hidden = true;
    bodyViewEl.hidden = false;
  }
  bodyViewEl?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-edit-body]')) enterBodyEdit();
  });

  async function saveBody() {
    if (!bodyArea) return;
    const v = bodyArea.value;
    if (await save({ body: v })) {
      bodySaved = v;
      if (previewEl) {
        previewEl.innerHTML = v.trim()
          ? renderPreview(v)
          : '<span class="task-edit-empty-trigger" data-edit-body>Sem descrição</span>';
        previewEl.classList.toggle('task-edit-preview-empty', !v.trim());
      }
      exitBodyEdit();
    }
  }
  bodySaveBtn?.addEventListener('click', saveBody);
  bodyCancelBtn?.addEventListener('click', () => {
    if (bodyArea) bodyArea.value = bodySaved;
    exitBodyEdit();
  });
  bodyArea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveBody(); }
    if (e.key === 'Escape') { e.preventDefault(); if (bodyArea) bodyArea.value = bodySaved; exitBodyEdit(); }
  });

  // Aviso ao sair com edição de texto pendente (só título/corpo — estruturados
  // já autosalvaram).
  window.addEventListener('beforeunload', (e) => {
    if (anyDirty() || queue.isBusy()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ── Responsáveis estilo ClickUp (spec 74) ──
// Popover num <details> nativo (spec: mesma mecânica do quick-edit do board — botão
// + painel; aqui o painel é o próprio <details>, que abre/fecha sem depender de JS).
// O form de checkboxes de dentro é o MESMO endpoint de sempre (POST
// /app/tasks/assignees, form-encoded, replace-set) — sem JS ele faz um POST normal
// (302 de volta pro detalhe, funcional). Com JS, o submit é interceptado por fetch
// (redirect:'manual' — 302 vira 'opaqueredirect', tratado como sucesso) pra
// atualizar os dots sem reload.
const assigneesRoot = document.querySelector<HTMLElement>('[data-assignees-picker]');
if (assigneesRoot) {
  const form = assigneesRoot.querySelector<HTMLFormElement>('[data-assignees-form]');
  const cancelBtn = assigneesRoot.querySelector<HTMLButtonElement>('[data-assignees-cancel]');
  const msgEl = assigneesRoot.querySelector<HTMLElement>('[data-assignees-msg]');

  function setMsg(text: string, cls: 'ok' | 'saving' | 'err' | '') {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'task-assignees-msg' + (cls ? ' ' + cls : '');
  }

  cancelBtn?.addEventListener('click', () => {
    form?.reset();
    setMsg('', '');
    assigneesRoot.removeAttribute('open');
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('Salvando...', 'saving');
    try {
      // Monta o body manualmente a partir dos inputs (em vez de iterar FormData
      // direto) — o client tsconfig não tem lib "DOM.Iterable", e já precisamos
      // da lista de checkboxes marcados logo abaixo mesmo.
      const checked = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="user_ids"]:checked'));
      const taskIdInput = form.querySelector<HTMLInputElement>('input[name="task_id"]');
      const params = new URLSearchParams();
      if (taskIdInput) params.append('task_id', taskIdInput.value);
      checked.forEach((c) => params.append('user_ids', c.value));
      const res = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      // redirect:'manual' devolve type='opaqueredirect' (status 0) em qualquer 3xx,
      // same-origin inclusive — é o sinal de sucesso (o endpoint só redireciona em
      // replace-set OK). Qualquer outra resposta não-ok é erro de verdade (400/404).
      if (res.type !== 'opaqueredirect' && !res.ok) {
        const text = await res.text().catch(() => '');
        setMsg('Erro ao salvar responsáveis' + (text ? ': ' + text : ''), 'err');
        return;
      }
      const selected: AssigneeDot[] = checked.map((c) => ({
        id: c.value,
        name: c.dataset.userName || c.value,
        type: c.dataset.userType === 'agent' ? 'agent' : 'person',
        avatar: c.dataset.userAvatar === '1',
      }));
      // Baseline novo pra Cancelar (sem salvar de novo) voltar pro estado recém-salvo.
      checked.forEach((c) => { c.defaultChecked = true; });
      Array.from(form.querySelectorAll<HTMLInputElement>('input[name="user_ids"]:not(:checked)'))
        .forEach((c) => { c.defaultChecked = false; });
      // Requery a cada save: o outerHTML anterior fica órfão (sem parent) depois de
      // substituído, então cachear a referência fora do handler quebraria no 2º save.
      const dotsEl = assigneesRoot.querySelector<HTMLElement>('.task-assignees');
      if (dotsEl) dotsEl.outerHTML = assigneeDotsHtml(selected);
      setMsg('Salvo', 'ok');
      assigneesRoot.removeAttribute('open');
    } catch {
      setMsg('Falha de conexão', 'err');
    }
  });
}

// ── Subtarefas / checklist (spec 38) ──
// Delegação de eventos na seção [data-subtasks] (itens entram e saem do DOM):
// checkbox → /subtask/toggle; form de adicionar → /subtask/add; × → /subtask/delete;
// duplo clique no título → input inline que salva em /subtask/update. Nenhuma
// dessas mutações toca o updated_at da task, então NADA aqui mexe no
// expectedUpdatedAt do editor — checklist e edição otimista não se atropelam.
const subtasksRoot = document.querySelector<HTMLElement>('[data-subtasks]');
if (subtasksRoot) {
  const subTaskId = subtasksRoot.dataset.subtasksTask || '';
  const listEl = subtasksRoot.querySelector<HTMLElement>('[data-subtasks-list]');
  const progressEl = subtasksRoot.querySelector<HTMLElement>('[data-subtasks-progress]');
  const addForm = subtasksRoot.querySelector<HTMLFormElement>('[data-subtask-add]');
  const addInput = subtasksRoot.querySelector<HTMLInputElement>('[data-subtask-input]');
  const msgEl = subtasksRoot.querySelector<HTMLElement>('[data-subtasks-msg]');

  function setSubMsg(text: string, isErr = false) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'task-subtasks-msg' + (isErr ? ' err' : '');
    if (text && !isErr) setTimeout(() => { if (msgEl.textContent === text) msgEl.textContent = ''; }, 1500);
  }

  function setProgress(p: { done: number; total: number } | undefined) {
    if (!progressEl || !p) return;
    progressEl.textContent = `${p.done}/${p.total}`;
    progressEl.hidden = p.total === 0;
  }

  // POST comum: devolve o JSON em sucesso, null em erro (com feedback no msg).
  async function subPost(op: string, body: Record<string, unknown>): Promise<any | null> {
    try {
      const res = await appFetch(`/app/tasks/subtask/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task_id: subTaskId, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubMsg('Erro: ' + ((data as any)?.error ?? res.status), true);
        return null;
      }
      setSubMsg('');
      return data;
    } catch {
      setSubMsg('Falha de conexão', true);
      return null;
    }
  }

  // Monta um <li> novo (item recém-adicionado) — via DOM API, nunca innerHTML
  // com texto do usuário.
  function buildItem(sub: { id: string; title: string }): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'task-subtask';
    li.dataset.subtaskId = sub.id;
    const label = document.createElement('label');
    label.className = 'task-subtask-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('data-subtask-toggle', '');
    cb.setAttribute('aria-label', 'Marcar subtarefa');
    const span = document.createElement('span');
    span.className = 'task-subtask-title';
    span.setAttribute('data-subtask-title', '');
    span.title = 'Duplo clique renomeia';
    span.textContent = sub.title;
    label.append(cb, span);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'task-subtask-remove';
    rm.setAttribute('data-subtask-remove', '');
    rm.title = 'Remover subtarefa';
    rm.setAttribute('aria-label', 'Remover subtarefa');
    rm.textContent = '×';
    li.append(label, rm);
    return li;
  }

  // Adicionar: Enter no input (submit do form).
  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = (addInput?.value ?? '').trim();
    if (!title) return;
    const data = await subPost('add', { title });
    if (!data) return;
    listEl?.appendChild(buildItem(data.subtask));
    if (addInput) { addInput.value = ''; addInput.focus(); }
    setProgress(data.progress);
  });

  // Toggle: change delegado nos checkboxes.
  listEl?.addEventListener('change', async (e) => {
    const cb = (e.target as HTMLElement).closest<HTMLInputElement>('[data-subtask-toggle]');
    if (!cb) return;
    const li = cb.closest<HTMLElement>('[data-subtask-id]');
    if (!li) return;
    const done = cb.checked;
    const data = await subPost('toggle', { id: li.dataset.subtaskId, done });
    if (!data) { cb.checked = !done; return; } // reverte em erro
    li.classList.toggle('done', done);
    setProgress(data.progress);
  });

  // Remover: click delegado no ×.
  listEl?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-subtask-remove]');
    if (!btn) return;
    const li = btn.closest<HTMLElement>('[data-subtask-id]');
    if (!li) return;
    btn.disabled = true;
    const data = await subPost('delete', { id: li.dataset.subtaskId });
    btn.disabled = false;
    if (!data) return;
    li.remove();
    setProgress(data.progress);
  });

  // Renomear: duplo clique no título troca por input inline. Enter/blur salvam
  // (se mudou), Esc cancela. O checkbox do label ignora cliques enquanto edita
  // (o input é irmão do span, fora do fluxo do toggle).
  listEl?.addEventListener('dblclick', (e) => {
    const span = (e.target as HTMLElement).closest<HTMLElement>('[data-subtask-title]');
    if (!span) return;
    const li = span.closest<HTMLElement>('[data-subtask-id]');
    if (!li || li.querySelector('.task-subtask-rename')) return;
    const original = span.textContent ?? '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-subtask-rename';
    input.maxLength = 200;
    input.value = original;
    span.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      const title = input.value.trim();
      if (save && title && title !== original) {
        const data = await subPost('update', { id: li.dataset.subtaskId, title });
        span.textContent = data ? data.subtask.title : original;
      } else {
        span.textContent = original;
      }
      input.replaceWith(span);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); void finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => { void finish(true); });
  });
}

// ── Visibilidade (spec 65) ──
// Wiring no módulo compartilhado (visibility-ui.ts) — a mesma seção existe no
// detalhe de NOTA (note-edit.ts). Endpoints vêm dos data-attributes da seção.
initVisibilityUi();

export {};
