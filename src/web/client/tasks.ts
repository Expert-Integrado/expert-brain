// Client da página /app/tasks — Kanban interativo.
// - Busca /app/tasks/data e renderiza as colunas CUSTOMIZÁVEIS vindas do banco
//   (fonte única = kanban_columns; não há mais array fixo aqui nem no SSR — spec 51).
// - Filtros (todas/hoje/semana/atrasadas) aplicam-se às colunas open/in_progress.
// - Drag-drop entre colunas → POST /app/tasks/move { id, column_id }. A mecânica
//   de arrasto vive em board-dnd.ts (Pointer Events, spec 65) — delegada no
//   container #task-board, então sobrevive aos re-renders daqui.
// - Card inteiro clicável (abre o detalhe); botão "concluir" → POST /app/tasks/complete.
// Sem dependências externas.

import { appFetch } from './http.js';
import { initBoardDnd } from './board-dnd.js';
import { toast } from './toast.js';
import { createSaveQueue, type SaveQueue, type SaveResult } from './save-queue.js';
import { PRIORITIES, priorityMeta, flagSvg } from '../../util/priority.js';
import { commentBadge } from '../../util/comment-badge.js';
import { tagChipsHtml, shareIconHtml, projectCrumbHtml, assigneeDotsHtml, type AssigneeDot } from '../../util/task-badges.js';

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
  project_id: string | null;
  private: boolean; // selo de privacidade (spec 59): badge 🔒 no card
  search_text: string; // título + descrição + tags, minúsculo/sem acento (Onda 8) — vem pronto do server
  assignees: AssigneeDot[]; // responsáveis (spec 37): bolinhas no card
}

interface BoardColumn {
  id: string;
  label: string;
  color: string | null;
  position: number;
  category: Status;
  tasks: TaskView[];
}

interface BoardProject {
  id: string;
  label: string;
  color: string | null;
  archived: boolean;
}

interface BoardData {
  now: number;
  columns: BoardColumn[];
  projects: BoardProject[];
}

type Filter = 'all' | 'today' | 'week' | 'overdue';

let board: BoardData | null = null;
let filter: Filter = 'all';
// Filtro de projeto (spec 58): 'all' | 'none' | '<project_id>'. Persiste em
// localStorage + query param (?project=). Aplica em TODAS as colunas.
let projectFilter = 'all';
// Busca + filtros de tag/prioridade (Onda 8): estado só em memória (por sessão de
// página) — persistir busca entre visitas confundiria mais do que ajudaria.
let searchQuery = '';
let tagFilter = 'all';
let prioFilter = 'all'; // 'all' | '1'..'4' | 'none'
// Mapa project_id → BoardProject, reconstruído a cada load (pro chip do card).
let projectsById = new Map<string, BoardProject>();

// Fold da query igual ao do server (foldSearchText em src/web/tasks.ts): minúsculo
// e sem acentos — "reuniao" acha "Reunião".
function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

async function load() {
  try {
    const res = await appFetch('/app/tasks/data');
    if (!res.ok) return;
    board = (await res.json()) as BoardData;
    projectsById = new Map((board.projects ?? []).map((p) => [p.id, p]));
    refreshTagFilterOptions();
    render();
    focusTaskFromQuery();
  } catch (err) {
    console.warn('tasks: load failed', err);
  }
}

// Card focado via ?task=<id> (spec 66: a paleta de comando abre o board com o card
// em destaque em vez de navegar pra um detalhe separado). Roda UMA vez (guardado por
// focusQueryHandled) — chamadas seguintes de load() (drag/drop, criar, completar)
// não re-disparam o scroll/destaque. Coluna recolhida (spec 52) é expandida primeiro
// pra revelar o card; id inexistente/filtrado desiste silenciosamente.
let focusQueryHandled = false;
function focusTaskFromQuery() {
  if (focusQueryHandled) return;
  const id = new URLSearchParams(location.search).get('task');
  if (!id) { focusQueryHandled = true; return; }

  let card = document.querySelector<HTMLElement>(`.task-card[data-id="${CSS.escape(id)}"]`);
  if (card) {
    const col = card.closest<HTMLElement>('.task-col');
    if (col?.classList.contains('collapsed') && col.dataset.col) {
      const map = loadCollapsed();
      delete map[col.dataset.col];
      saveCollapsed(map);
      render();
      card = document.querySelector<HTMLElement>(`.task-card[data-id="${CSS.escape(id)}"]`);
    }
  }
  focusQueryHandled = true;
  if (!card) return;
  card.classList.add('task-card-focused');
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => card.classList.remove('task-card-focused'), 2400);
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

// Breadcrumb de projeto do card (Onda 5): resolve o project_id no BoardProject do payload.
function projectCrumb(t: TaskView): string {
  if (!t.project_id) return '';
  const p = projectsById.get(t.project_id);
  return p ? projectCrumbHtml({ label: p.label, color: p.color, archived: p.archived }) : '';
}

// Badge 🔒 do card (spec 59) — mesma classe global .private-badge das notas/SSR.
const PRIVATE_BADGE = '<span class="private-badge" title="Tarefa privada — invisível pra credenciais sem escopo private">🔒 privada</span>';

// Anatomia do card no padrão ClickUp (Onda 5, decisão do gate da Onda 1): título
// PRIMEIRO (clamp 2 linhas, com o ✎ de edição rápida ao lado), breadcrumb de
// projeto muted, UMA linha de meta (prio + prazo + comentários + selo privada +
// link) e UMA linha de tags sem wrap. Mesma estrutura do renderCardSSR
// (src/web/tasks.ts) — manter em sincronia.
function cardHTML(t: TaskView): string {
  const canClose = t.status === 'open' || t.status === 'in_progress';
  const tags = tagChipsHtml(t.tags);
  return `<div class="task-card" data-id="${esc(t.id)}" data-status="${esc(t.status)}"${t.project_id ? ` data-project="${esc(t.project_id)}"` : ''} data-updated-at="${t.updated_at}">
    <div class="task-card-top">
      <a class="task-card-title" href="/app/tasks/${esc(t.id)}" draggable="false">${esc(t.title)}</a>
      <button class="task-btn task-quickedit-btn" data-quickedit="${esc(t.id)}" type="button" title="Editar prazo/prioridade" aria-label="Editar prazo e prioridade">✎</button>
    </div>
    ${projectCrumb(t)}
    <div class="task-card-meta">${prioPill(t.priority)}${dueBadge(t)}${commentBadge(t.comment_count)}${t.private ? PRIVATE_BADGE : ''}${shareIconHtml(t.share_expires_brt)}${assigneeDotsHtml(t.assignees ?? [])}</div>
    ${tags ? `<div class="task-card-tags">${tags}</div>` : ''}
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
    ${canClose ? `<div class="task-card-actions"><button class="btn btn-sm btn-ghost task-complete" data-id="${esc(t.id)}" type="button">✓ concluir</button></div>` : ''}
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

// Filtro de projeto (spec 58): aplica em TODAS as colunas (open/done/canceled).
// 'all' = tudo; 'none' = só sem projeto; '<id>' = só aquele projeto.
function passesProject(t: TaskView): boolean {
  if (projectFilter === 'all') return true;
  if (projectFilter === 'none') return !t.project_id;
  return t.project_id === projectFilter;
}

// Busca por texto (Onda 8): TODOS os termos da query (separados por espaço) precisam
// aparecer no search_text do card (título + descrição + tags, já foldado no server).
function passesSearch(t: TaskView): boolean {
  if (!searchQuery) return true;
  const hay = t.search_text || fold(t.title);
  return searchQuery.split(/\s+/).every((term) => !term || hay.includes(term));
}

function passesTag(t: TaskView): boolean {
  return tagFilter === 'all' || t.tags.includes(tagFilter);
}

function passesPrio(t: TaskView): boolean {
  if (prioFilter === 'all') return true;
  if (prioFilter === 'none') return t.priority === null;
  return t.priority === Number(prioFilter);
}

// Filtro de vencimento só se aplica a colunas de categoria open/in_progress; done/
// canceled mostram sempre o histórico recente, sem filtro. Busca + projeto + tag +
// prioridade aplicam por cima em TODAS as colunas.
function columnTasks(col: BoardColumn, now: number): TaskView[] {
  let items = col.tasks.filter((t) => passesProject(t) && passesSearch(t) && passesTag(t) && passesPrio(t));
  if (col.category === 'open' || col.category === 'in_progress') {
    items = items.filter((t) => passesFilter(t, now));
  }
  return items;
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
        ${items.map(cardHTML).join('') || '<div class="task-col-empty">Solte tarefas aqui</div>'}
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
        toast('Não foi possível criar a tarefa — tenta de novo.');
      } catch (err) {
        console.warn('tasks: inline create failed', err);
        toast('Não foi possível criar a tarefa — tenta de novo.');
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
    toast('Não foi possível mover a tarefa — o board foi recarregado.');
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
    toast('Não foi possível concluir a tarefa — tenta de novo.');
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

// ── Filtro de projeto (spec 58): query param ?project= tem prioridade, senão
// localStorage. Persiste nos dois a cada mudança (sobrevive a reload + link
// compartilhável). O select é montado no SSR com todos os projetos.
const PROJECT_FILTER_KEY = 'kanban_project_filter';

function initialProjectFilter(): string {
  const q = new URLSearchParams(location.search).get('project');
  if (q) return q;
  try {
    const stored = localStorage.getItem(PROJECT_FILTER_KEY);
    if (stored) return stored;
  } catch { /* privado/quota: ignora */ }
  return 'all';
}

function persistProjectFilter(v: string) {
  try { localStorage.setItem(PROJECT_FILTER_KEY, v); } catch { /* ignora */ }
  const url = new URL(location.href);
  if (v === 'all') url.searchParams.delete('project');
  else url.searchParams.set('project', v);
  history.replaceState(null, '', url.toString());
}

function wireProjectFilter() {
  const sel = document.getElementById('task-project-filter') as HTMLSelectElement | null;
  if (!sel) return;
  let want = initialProjectFilter();
  // Se o valor salvo não existe mais como opção (projeto removido do select), cai em 'all'.
  if (!Array.from(sel.options).some((o) => o.value === want)) want = 'all';
  projectFilter = want;
  sel.value = want;
  persistProjectFilter(want); // normaliza o query param já no load
  sel.addEventListener('change', () => {
    projectFilter = sel.value || 'all';
    persistProjectFilter(projectFilter);
    render();
  });
}

// ── Busca + filtros de tag/prioridade (Onda 8) ──
// Busca com debounce curto: re-render do board é barato, mas não a cada keystroke.
function wireSearch() {
  const input = document.getElementById('task-search') as HTMLInputElement | null;
  if (!input) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      searchQuery = fold(input.value.trim());
      render();
    }, 120);
  });
}

function wirePrioFilter() {
  const sel = document.getElementById('task-prio-filter') as HTMLSelectElement | null;
  if (!sel) return;
  sel.addEventListener('change', () => {
    prioFilter = sel.value || 'all';
    render();
  });
}

// ── Filtro de tag (P1 audit item T1): popover com busca no lugar do <select>
// nativo — o vocabulário de tags do dono passa de centenas de itens, inviável sem
// typeahead. Trigger mostra "Todas as tags" ou o nome da tag ativa (virando chip
// com × pra limpar, estilo ClickUp); painel tem busca no topo + lista filtrada.
let tagOptionsCache: string[] = [];

function updateTagTriggerUI() {
  const wrap = document.getElementById('task-tag-filter');
  const label = document.getElementById('task-tag-trigger-label');
  const clearBtn = document.getElementById('task-tag-clear') as HTMLButtonElement | null;
  if (!wrap || !label || !clearBtn) return;
  const hasValue = tagFilter !== 'all';
  label.textContent = hasValue ? tagFilter : 'Todas as tags';
  wrap.classList.toggle('has-value', hasValue);
  clearBtn.hidden = !hasValue;
}

function renderTagOptions(query: string) {
  const list = document.getElementById('task-tag-list');
  if (!list) return;
  const q = fold(query.trim());
  const filtered = tagOptionsCache.filter((t) => !q || fold(t).includes(q));
  const rows = [
    `<button type="button" class="task-tag-opt${tagFilter === 'all' ? ' selected' : ''}" data-tag-value="all">Todas as tags</button>`,
  ];
  if (filtered.length === 0 && q) {
    rows.push(`<div class="task-tag-empty">Nenhuma tag encontrada</div>`);
  } else {
    for (const t of filtered) {
      rows.push(`<button type="button" class="task-tag-opt${tagFilter === t ? ' selected' : ''}" data-tag-value="${esc(t)}">${esc(t)}</button>`);
    }
  }
  list.innerHTML = rows.join('');
  list.querySelectorAll<HTMLButtonElement>('.task-tag-opt[data-tag-value]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tagFilter = btn.dataset.tagValue || 'all';
      updateTagTriggerUI();
      closeTagPanel();
      render();
    });
  });
}

function onTagOutsideClick(e: MouseEvent) {
  const wrap = document.getElementById('task-tag-filter');
  if (wrap && !wrap.contains(e.target as Node)) closeTagPanel();
}

function onTagPanelKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeTagPanel();
    document.getElementById('task-tag-trigger')?.focus();
  }
}

function openTagPanel() {
  const panel = document.getElementById('task-tag-panel');
  const trigger = document.getElementById('task-tag-trigger');
  const search = document.getElementById('task-tag-search') as HTMLInputElement | null;
  if (!panel || !trigger) return;
  panel.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  if (search) search.value = '';
  renderTagOptions('');
  setTimeout(() => search?.focus(), 10);
  document.addEventListener('click', onTagOutsideClick, true);
  document.addEventListener('keydown', onTagPanelKeydown);
}

function closeTagPanel() {
  const panel = document.getElementById('task-tag-panel');
  const trigger = document.getElementById('task-tag-trigger');
  if (!panel || !trigger || panel.hidden) return;
  panel.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onTagOutsideClick, true);
  document.removeEventListener('keydown', onTagPanelKeydown);
}

function wireTagFilter() {
  const trigger = document.getElementById('task-tag-trigger');
  const clearBtn = document.getElementById('task-tag-clear');
  const search = document.getElementById('task-tag-search') as HTMLInputElement | null;
  const panel = document.getElementById('task-tag-panel');
  if (!trigger || !clearBtn || !search || !panel) return;

  trigger.addEventListener('click', () => {
    if (panel.hidden) openTagPanel(); else closeTagPanel();
  });
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    tagFilter = 'all';
    updateTagTriggerUI();
    if (!panel.hidden) renderTagOptions(search.value);
    render();
  });
  search.addEventListener('input', () => renderTagOptions(search.value));
  // Enter na busca aplica o único resultado filtrado (fluxo rápido de teclado).
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = fold(search.value.trim());
    const matches = tagOptionsCache.filter((t) => !q || fold(t).includes(q));
    if (matches.length === 1) {
      tagFilter = matches[0];
      updateTagTriggerUI();
      closeTagPanel();
      render();
    }
  });

  updateTagTriggerUI();
}

// Re-popula a lista de tags do popover com a união das tags do board recém-carregado
// (edição inline muda tags sem reload de página). Preserva a seleção quando a tag
// ainda existe; senão volta pra 'all'.
function refreshTagFilterOptions() {
  if (!board) return;
  const tags = new Set<string>();
  for (const col of board.columns) for (const t of col.tasks) for (const tag of t.tags) tags.add(tag);
  tagOptionsCache = [...tags].sort((a, b) => a.localeCompare(b));
  if (tagFilter !== 'all' && !tags.has(tagFilter)) tagFilter = 'all';
  updateTagTriggerUI();
  const panel = document.getElementById('task-tag-panel');
  const search = document.getElementById('task-tag-search') as HTMLInputElement | null;
  if (panel && !panel.hidden) renderTagOptions(search?.value ?? '');
}

wireFilters();
wireProjectFilter();
wireSearch();
wirePrioFilter();
wireTagFilter();
wireCreateModal();
// DnD + card clicável (spec 65): delegado no container, wired UMA vez — os
// re-renders trocam o innerHTML mas o listener fica no #task-board.
{
  const boardEl = document.getElementById('task-board');
  if (boardEl) {
    initBoardDnd(boardEl, {
      // O servidor deriva status + completed_at da categoria da coluna destino —
      // inclusive done (grava completed_at). Um único caminho pra todas as colunas.
      onDrop: (id, columnId) => move(id, columnId),
      onOpen: (id) => location.assign(`/app/tasks/${encodeURIComponent(id)}`),
    });
  }
}
load();

export {};
