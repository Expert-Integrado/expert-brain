// Client da página /app/tasks — Kanban interativo.
// - Busca /app/tasks/data e renderiza as colunas CUSTOMIZÁVEIS vindas do banco
//   (fonte única = kanban_columns; não há mais array fixo aqui nem no SSR — spec 51).
// - Filtros (todas/hoje/semana/atrasadas) aplicam-se às colunas open/in_progress.
// - Drag-drop entre colunas → POST /app/tasks/move { id, column_id }.
// - Botão "concluir" → POST /app/tasks/complete.
// Sem dependências externas (DnD nativo do HTML5).

import { appFetch } from './http.js';
import { createSaveQueue, type SaveQueue, type SaveResult } from './save-queue.js';
import { PRIORITIES, priorityMeta, flagSvg } from '../../util/priority.js';
import { commentBadge } from '../../util/comment-badge.js';
import { tagChipsHtml, shareIconHtml } from '../../util/task-badges.js';

type Status = 'open' | 'in_progress' | 'done' | 'canceled';

interface TaskView {
  id: string;
  title: string;
  status: Status;
  priority: number | null;
  due_at: number | null;
  due_brt: string | null;
  due_local: string | null;
  due_date: string | null; // "2026-06-22" p/ <input type="date">
  due_time: string | null; // "14:00" p/ <input type="time"> — '' quando sem hora
  when: string | null;
  overdue: boolean;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
  comment_count: number;
  tags: string[];
  shared: boolean;
  share_expires_brt: string | null;
}

interface BoardColumn {
  id: string;
  label: string;
  color: string | null;
  position: number;
  category: Status;
  tasks: TaskView[];
}

interface BoardData {
  now: number;
  columns: BoardColumn[];
}

type Filter = 'all' | 'today' | 'week' | 'overdue';

let board: BoardData | null = null;
let filter: Filter = 'all';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

async function load() {
  try {
    const res = await appFetch('/app/tasks/data');
    if (!res.ok) return;
    board = (await res.json()) as BoardData;
    render();
  } catch (err) {
    console.warn('tasks: load failed', err);
  }
}

// Fim do dia calendário corrente em America/Sao_Paulo, em epoch ms (spec 28).
// `now` vem de board.now (relógio do servidor) — imune a relógio local errado.
// Sem libs: Intl nativo. Assim "Vencem hoje" = dia calendário BRT (incluindo
// atrasadas), alinhado ao list_tasks_due_today do MCP, em vez de "próximas 24h".
function endOfDayBRT(now: number): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsedMs = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;
  return now + (86_400_000 - elapsedMs) - 1;
}

function passesFilter(t: TaskView, now: number): boolean {
  if (filter === 'all') return true;
  if (t.due_at === null) return false;
  if (filter === 'overdue') return t.overdue;
  if (filter === 'today') return t.due_at <= endOfDayBRT(now);
  if (filter === 'week') return t.due_at <= now + 7 * 24 * 3600_000;
  return true;
}

// Bandeirinha de prioridade estilo ClickUp (flag colorida + rótulo). Compartilha
// PRIORITIES/flagSvg com o server (util/priority.ts) — render idêntico ao SSR.
function prioPill(p: number | null): string {
  const m = priorityMeta(p);
  if (!m) return '';
  return `<span class="task-prio task-prio-p${m.value}" title="Prioridade: ${esc(m.label)}">${flagSvg(m.color)}<span class="task-prio-lbl">${esc(m.label)}</span></span>`;
}

function dueBadge(t: TaskView): string {
  if (!t.due_brt) return '';
  const cls = t.overdue ? 'task-due overdue' : 'task-due';
  return `<span class="${cls}">${esc(t.due_brt)}${t.when ? ` · ${esc(t.when)}` : ''}</span>`;
}

// Popover de edição rápida no card: prioridade (select) + prazo (DATA + HORA
// separados, hora opcional — spec 36 fase 2). Autosave on-change → POST
// /app/tasks/update com expected_updated_at do card. Escondido por default.
function prioOptions(p: number | null): string {
  const opts = [`<option value=""${p === null ? ' selected' : ''}>Sem prioridade</option>`];
  for (const m of PRIORITIES) opts.push(`<option value="${m.value}"${p === m.value ? ' selected' : ''}>${esc(m.label)}</option>`);
  return opts.join('');
}

function cardHTML(t: TaskView): string {
  const canClose = t.status === 'open' || t.status === 'in_progress';
  return `<div class="task-card" data-id="${esc(t.id)}" data-status="${esc(t.status)}" data-updated-at="${t.updated_at}" draggable="true">
    <div class="task-card-head">${prioPill(t.priority)}${tagChipsHtml(t.tags)}${shareIconHtml(t.share_expires_brt)}
      <button class="task-btn task-quickedit-btn" data-quickedit="${esc(t.id)}" type="button" title="Editar prazo/prioridade" aria-label="Editar prazo e prioridade">✎</button>
    </div>
    <a class="task-card-title" href="/app/tasks/${esc(t.id)}">${esc(t.title)}</a>
    <div class="task-card-meta">${dueBadge(t)}${commentBadge(t.comment_count)}</div>
    <div class="task-card-edit" data-editpanel hidden>
      <label class="task-card-edit-ctl">Prioridade
        <select class="task-card-prio" data-qe-prio>${prioOptions(t.priority)}</select>
      </label>
      <div class="task-card-edit-ctl">Prazo
        <div class="task-card-edit-daterow">
          <input type="date" class="task-card-due-date" data-qe-due-date value="${t.due_date ? esc(t.due_date) : ''}" aria-label="Data" />
          <input type="time" class="task-card-due-time" data-qe-due-time value="${t.due_time ? esc(t.due_time) : ''}" aria-label="Hora (opcional)" />
        </div>
      </div>
      <div class="task-card-edit-row">
        <button class="task-btn task-qe-clear" data-qe-clear type="button">limpar prazo</button>
        <span class="task-card-edit-msg" data-qe-msg></span>
      </div>
    </div>
    <div class="task-card-actions">
      ${canClose ? `<button class="task-btn task-complete" data-id="${esc(t.id)}" type="button">✓ concluir</button>` : ''}
      <a class="task-btn task-open" href="/app/tasks/${esc(t.id)}">abrir</a>
    </div>
  </div>`;
}

// Combina os inputs DATA + HORA num payload `due` pro endpoint. Data vazia → null
// (limpa). Só data (hora vazia) → "2026-07-10" (parseDueToMs trata como fim do dia).
// Data + hora → "2026-07-10T14:00".
function composeDue(date: string, time: string): string | null {
  const d = date.trim();
  if (!d) return null;
  const t = time.trim();
  return t ? `${d}T${t}` : d;
}

// Cor de coluna só vale como hex #rrggbb; qualquer outra coisa vira neutro.
function safeColor(color: string | null): string | null {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

function colSwatch(color: string | null): string {
  const c = safeColor(color);
  return `<span class="task-col-dot"${c ? ` style="background:${esc(c)}"` : ''}></span>`;
}

// Filtro de vencimento só se aplica a colunas de categoria open/in_progress; done/
// canceled mostram sempre o histórico recente, sem filtro.
function columnTasks(col: BoardColumn, now: number): TaskView[] {
  if (col.category === 'open' || col.category === 'in_progress') {
    return col.tasks.filter((t) => passesFilter(t, now));
  }
  return col.tasks;
}

// Colapsar coluna (spec 52): estado por coluna em localStorage, sobrevive a reload.
// Mapa { [column_id]: true } — ausente/false = expandida (default).
const COLLAPSE_KEY = 'kanban_collapsed';

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveCollapsed(map: Record<string, boolean>): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map)); } catch { /* privado/quota: ignora */ }
}

function render() {
  const root = document.getElementById('task-board');
  if (!root || !board) return;
  const now = board.now;
  const collapsed = loadCollapsed();

  root.innerHTML = board.columns.map((col) => {
    const items = columnTasks(col, now);
    const c = safeColor(col.color);
    const isCollapsed = collapsed[col.id] === true;
    return `<section class="task-col${isCollapsed ? ' collapsed' : ''}" data-col="${esc(col.id)}" data-category="${esc(col.category)}"${c ? ` style="--col-accent:${esc(c)}"` : ''}>
      <header class="task-col-head">
        <span class="task-col-label">${colSwatch(col.color)}${esc(col.label)}</span>
        <div class="task-col-head-right">
          <span class="task-col-count" data-count="${esc(col.id)}">${items.length}</span>
          <button class="task-col-collapse-btn" data-collapse-toggle="${esc(col.id)}" type="button"
            aria-label="${isCollapsed ? 'Expandir coluna' : 'Recolher coluna'}" title="${isCollapsed ? 'Expandir' : 'Recolher'}">${isCollapsed ? '▸' : '▾'}</button>
        </div>
      </header>
      <div class="task-col-body" data-dropzone="${esc(col.id)}">
        ${items.map(cardHTML).join('') || '<div class="task-col-empty">—</div>'}
      </div>
      <div class="task-col-inline-create">
        <input type="text" class="task-col-inline-input" data-inline-input="${esc(col.id)}" placeholder="+ Nova tarefa" maxlength="200" autocomplete="off" aria-label="Nova tarefa nesta coluna" />
      </div>
    </section>`;
  }).join('');

  const totalOpen = board.columns
    .filter((c) => c.category === 'open' || c.category === 'in_progress')
    .reduce((n, c) => n + c.tasks.length, 0);
  const countEl = document.getElementById('tasks-count');
  if (countEl) countEl.textContent = `${totalOpen} aberta${totalOpen === 1 ? '' : 's'}`;

  wireCards();
  wireDropzones();
  wireCollapseToggles();
  wireInlineCreate();
}

// Toggle de colapso por coluna — persiste e re-renderiza (board já está em memória,
// sem round-trip). Ver loadCollapsed/saveCollapsed acima.
function wireCollapseToggles() {
  document.querySelectorAll<HTMLButtonElement>('[data-collapse-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.collapseToggle;
      if (!id) return;
      const map = loadCollapsed();
      if (map[id]) delete map[id]; else map[id] = true;
      saveCollapsed(map);
      render();
    });
  });
}

// "+ Nova tarefa" inline no rodapé de cada coluna (spec 52): Enter cria já na
// coluna certa (POST /app/tasks/create com column_id); Esc limpa o campo.
function wireInlineCreate() {
  document.querySelectorAll<HTMLInputElement>('[data-inline-input]').forEach((input) => {
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        input.blur();
        return;
      }
      if (e.key !== 'Enter') return;
      const title = input.value.trim();
      if (!title) return;
      const columnId = input.dataset.inlineInput || '';
      input.disabled = true;
      try {
        const res = await appFetch('/app/tasks/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, column_id: columnId }),
        });
        if (res.ok) {
          input.value = '';
          await load();
          return; // load() já re-renderiza (novo input não fica desabilitado)
        }
        console.warn('tasks: inline create failed', res.status);
      } catch (err) {
        console.warn('tasks: inline create failed', err);
      }
      input.disabled = false;
      input.focus();
    });
  });
}

// Move um card pra uma coluna (drag & drop). O servidor deriva status + completed_at
// da categoria da coluna — o client só informa o column_id destino. Reconcilia
// recarregando o board no fim.
async function move(id: string, columnId: string) {
  try {
    const res = await appFetch('/app/tasks/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, column_id: columnId }),
    });
    if (!res.ok) throw new Error('move ' + res.status);
  } catch (err) {
    console.warn('tasks: move failed', err);
  }
  await load();
}

async function complete(id: string) {
  try {
    const res = await appFetch('/app/tasks/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error('complete ' + res.status);
  } catch (err) {
    console.warn('tasks: complete failed', err);
  }
  await load();
}

// Fila de save por card: mudar prioridade e prazo em <1s vira cadeia sequencial
// com updated_at fresco (sem 409 auto-infligido). WeakMap card → SaveQueue, criada
// on demand no wire. O reload do board acontece SÓ quando a fila drena (não a cada
// save intermediário) — assim o DOM do card não é destruído no meio da rajada, e os
// controles refletem o valor final. Em 409, recarrega (estado real veio de fora).
const cardQueues = new WeakMap<HTMLElement, SaveQueue>();

function queueFor(card: HTMLElement, msgEl: HTMLElement | null): SaveQueue {
  let q = cardQueues.get(card);
  if (q) return q;
  const id = card.dataset.id || '';
  q = createSaveQueue({
    getExpected: () => (card.dataset.updatedAt ? Number(card.dataset.updatedAt) : null),
    setExpected: (v) => { card.dataset.updatedAt = String(v); },
    send: async (patch, expected): Promise<SaveResult> => {
      if (msgEl) { msgEl.textContent = 'salvando...'; msgEl.className = 'task-card-edit-msg saving'; }
      try {
        const res = await appFetch('/app/tasks/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, patch, expected_updated_at: expected }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          if (msgEl) { msgEl.textContent = 'editada em outro lugar — recarregando'; msgEl.className = 'task-card-edit-msg err'; }
          await load();
          return { ok: false, updatedAt: null };
        }
        if (!res.ok) {
          if (msgEl) { msgEl.textContent = 'erro'; msgEl.className = 'task-card-edit-msg err'; }
          return { ok: false, updatedAt: null };
        }
        if (msgEl) { msgEl.textContent = 'salvo'; msgEl.className = 'task-card-edit-msg ok'; }
        const ua = typeof (data as any).updated_at === 'number' ? (data as any).updated_at : null;
        // Reload só quando NÃO há mais nada pendente/em voo — evita reconstruir o card
        // no meio da rajada. Adiado pro próximo tick pra o isBusy refletir o estado final.
        setTimeout(() => { if (q && !q.isBusy()) void load(); }, 0);
        return { ok: true, updatedAt: ua };
      } catch (err) {
        if (msgEl) { msgEl.textContent = 'falha'; msgEl.className = 'task-card-edit-msg err'; }
        return { ok: false, updatedAt: null };
      }
    },
  });
  cardQueues.set(card, q);
  return q;
}

function quickUpdate(card: HTMLElement, patch: Record<string, unknown>, msgEl: HTMLElement | null) {
  if (!card.dataset.id) return;
  queueFor(card, msgEl).enqueue(patch);
}

function wireCards() {
  document.querySelectorAll<HTMLButtonElement>('.task-complete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      if (id) complete(id);
    });
  });
  // Toggle do popover de edição rápida (✎).
  document.querySelectorAll<HTMLButtonElement>('.task-quickedit-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest<HTMLElement>('.task-card');
      const panel = card?.querySelector<HTMLElement>('[data-editpanel]');
      if (panel) panel.hidden = !panel.hidden;
    });
  });
  // Autosave dos controles do popover (prioridade + DATA/HORA separados).
  document.querySelectorAll<HTMLElement>('.task-card').forEach((card) => {
    const msg = card.querySelector<HTMLElement>('[data-qe-msg]');
    const prio = card.querySelector<HTMLSelectElement>('[data-qe-prio]');
    const dueDate = card.querySelector<HTMLInputElement>('[data-qe-due-date]');
    const dueTime = card.querySelector<HTMLInputElement>('[data-qe-due-time]');
    const clearBtn = card.querySelector<HTMLButtonElement>('[data-qe-clear]');
    prio?.addEventListener('change', () => {
      quickUpdate(card, { priority: prio.value === '' ? null : Number(prio.value) }, msg);
    });
    const saveDue = () => {
      const due = composeDue(dueDate?.value ?? '', dueTime?.value ?? '');
      quickUpdate(card, { due }, msg);
    };
    dueDate?.addEventListener('change', saveDue);
    dueTime?.addEventListener('change', saveDue);
    clearBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (dueDate) dueDate.value = '';
      if (dueTime) dueTime.value = '';
      quickUpdate(card, { due: null }, msg);
    });

    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      document.body.classList.add('task-dragging');
      (e as DragEvent).dataTransfer?.setData('text/plain', card.dataset.id || '');
      if ((e as DragEvent).dataTransfer) (e as DragEvent).dataTransfer!.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.body.classList.remove('task-dragging');
      document.querySelectorAll('.task-col-body.drag-over').forEach((z) => z.classList.remove('drag-over'));
    });
  });
}

function wireDropzones() {
  document.querySelectorAll<HTMLElement>('.task-col-body').forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      // Cursor "move" (não "copy") durante o arrasto sobre um alvo válido.
      const dt = (e as DragEvent).dataTransfer;
      if (dt) dt.dropEffect = 'move';
      zone.classList.add('drag-over');
    });
    // dragleave dispara ao entrar num filho; só limpa se o ponteiro saiu de fato da zona.
    zone.addEventListener('dragleave', (e) => {
      const rel = (e as DragEvent).relatedTarget as Node | null;
      if (!rel || !zone.contains(rel)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const id = (e as DragEvent).dataTransfer?.getData('text/plain');
      const columnId = zone.dataset.dropzone;
      if (!id || !columnId) return;
      // O servidor deriva status + completed_at da categoria da coluna destino —
      // inclusive done (grava completed_at). Um único caminho pra todas as colunas.
      move(id, columnId);
    });
  });
}

// ── Modal "Nova task" (spec 36 fase 2) ──
function wireCreateModal() {
  const modal = document.getElementById('task-create-modal');
  const openBtn = document.getElementById('task-new-btn');
  const form = document.getElementById('task-create-form') as HTMLFormElement | null;
  if (!modal || !openBtn || !form) return;

  const titleInput = form.querySelector<HTMLInputElement>('#task-create-title-input');
  const msg = form.querySelector<HTMLElement>('[data-create-msg]');
  const submitBtn = form.querySelector<HTMLButtonElement>('.task-create-submit');

  function openModal() {
    modal!.hidden = false;
    modal!.setAttribute('aria-hidden', 'false');
    setTimeout(() => titleInput?.focus(), 20);
  }
  function closeModal() {
    modal!.hidden = true;
    modal!.setAttribute('aria-hidden', 'true');
    form!.reset();
    if (msg) { msg.textContent = ''; msg.className = 'task-create-msg'; }
  }

  openBtn.addEventListener('click', openModal);
  modal.querySelectorAll('[data-close-modal]').forEach((el) =>
    el.addEventListener('click', (e) => { e.preventDefault(); closeModal(); })
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    if (!title) { if (msg) { msg.textContent = 'Título é obrigatório'; msg.className = 'task-create-msg err'; } titleInput?.focus(); return; }

    const payload: Record<string, unknown> = { title };
    const bodyVal = String(data.get('body') || '').trim();
    if (bodyVal) payload.body = bodyVal;
    const prioVal = String(data.get('priority') || '');
    if (prioVal) payload.priority = Number(prioVal);
    const due = composeDue(String(data.get('due_date') || ''), String(data.get('due_time') || ''));
    if (due) payload.due = due;

    if (submitBtn) submitBtn.disabled = true;
    if (msg) { msg.textContent = 'Criando...'; msg.className = 'task-create-msg saving'; }
    try {
      const res = await appFetch('/app/tasks/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msg) { msg.textContent = 'Erro: ' + ((out as any).error || res.status); msg.className = 'task-create-msg err'; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      closeModal();
      await load(); // recarrega o board — o card novo aparece sem reload da página.
    } catch (err) {
      if (msg) { msg.textContent = 'Falha de conexão'; msg.className = 'task-create-msg err'; }
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function wireFilters() {
  document.querySelectorAll<HTMLButtonElement>('.task-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.task-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      filter = (btn.dataset.filter as Filter) || 'all';
      render();
    });
  });
}

wireFilters();
wireCreateModal();
load();

export {};
