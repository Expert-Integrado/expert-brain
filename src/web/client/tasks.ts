// Client da página /app/tasks — Kanban interativo.
// - Busca /app/tasks/data e renderiza as 3 colunas (substitui o SSR).
// - Filtros (todas/hoje/semana/atrasadas) aplicam-se às colunas abertas.
// - Drag-drop entre colunas → POST /app/tasks/status.
// - Botão "concluir" → POST /app/tasks/complete.
// Sem dependências externas (DnD nativo do HTML5).

import { appFetch } from './http.js';

type Status = 'open' | 'in_progress' | 'done' | 'canceled';

interface TaskView {
  id: string;
  title: string;
  status: Status;
  priority: number | null;
  due_at: number | null;
  due_brt: string | null;
  when: string | null;
  overdue: boolean;
  created_at: number;
  completed_at: number | null;
}

interface BoardData {
  now: number;
  columns: { open: TaskView[]; in_progress: TaskView[]; done: TaskView[] };
}

type Filter = 'all' | 'today' | 'week' | 'overdue';

const COLS: Array<{ key: Exclude<Status, 'canceled'>; label: string }> = [
  { key: 'open', label: 'A fazer' },
  { key: 'in_progress', label: 'Em progresso' },
  { key: 'done', label: 'Concluído' },
];

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

function passesFilter(t: TaskView, now: number): boolean {
  if (filter === 'all') return true;
  if (t.due_at === null) return false;
  if (filter === 'overdue') return t.overdue;
  if (filter === 'today') return t.due_at <= now + 24 * 3600_000;
  if (filter === 'week') return t.due_at <= now + 7 * 24 * 3600_000;
  return true;
}

function prioPill(p: number | null): string {
  if (p === null) return '';
  return `<span class="task-prio task-prio-p${p}" title="Prioridade ${p}">P${p}</span>`;
}

function dueBadge(t: TaskView): string {
  if (!t.due_brt) return '';
  const cls = t.overdue ? 'task-due overdue' : 'task-due';
  return `<span class="${cls}">${esc(t.due_brt)}${t.when ? ` · ${esc(t.when)}` : ''}</span>`;
}

function cardHTML(t: TaskView): string {
  const canClose = t.status === 'open' || t.status === 'in_progress';
  return `<div class="task-card" data-id="${esc(t.id)}" data-status="${esc(t.status)}" draggable="true">
    <div class="task-card-head">${prioPill(t.priority)}${dueBadge(t)}</div>
    <a class="task-card-title" href="/app/tasks/${esc(t.id)}">${esc(t.title)}</a>
    <div class="task-card-actions">
      ${canClose ? `<button class="task-btn task-complete" data-id="${esc(t.id)}" type="button">✓ concluir</button>` : ''}
      <a class="task-btn task-open" href="/app/tasks/${esc(t.id)}">abrir</a>
    </div>
  </div>`;
}

function render() {
  const root = document.getElementById('task-board');
  if (!root || !board) return;
  const now = board.now;

  const colData: Record<string, TaskView[]> = {
    open: board.columns.open.filter((t) => passesFilter(t, now)),
    in_progress: board.columns.in_progress.filter((t) => passesFilter(t, now)),
    // a coluna concluído sempre mostra o histórico recente, sem filtro de vencimento
    done: board.columns.done,
  };

  root.innerHTML = COLS.map((c) => {
    const items = colData[c.key];
    return `<section class="task-col" data-col="${c.key}">
      <header class="task-col-head"><span class="task-col-label">${esc(c.label)}</span><span class="task-col-count" data-count="${c.key}">${items.length}</span></header>
      <div class="task-col-body" data-dropzone="${c.key}">
        ${items.map(cardHTML).join('') || '<div class="task-col-empty">—</div>'}
      </div>
    </section>`;
  }).join('');

  const totalOpen = board.columns.open.length + board.columns.in_progress.length;
  const countEl = document.getElementById('tasks-count');
  if (countEl) countEl.textContent = `${totalOpen} aberta${totalOpen === 1 ? '' : 's'}`;

  wireCards();
  wireDropzones();
}

async function setStatus(id: string, status: Status) {
  // Otimista: muda local e re-renderiza; reconcilia no fim recarregando.
  if (!board) return;
  try {
    const res = await appFetch('/app/tasks/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) throw new Error('status ' + res.status);
  } catch (err) {
    console.warn('tasks: setStatus failed', err);
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

function wireCards() {
  document.querySelectorAll<HTMLButtonElement>('.task-complete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      if (id) complete(id);
    });
  });
  document.querySelectorAll<HTMLElement>('.task-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      (e as DragEvent).dataTransfer?.setData('text/plain', card.dataset.id || '');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
}

function wireDropzones() {
  document.querySelectorAll<HTMLElement>('.task-col-body').forEach((zone) => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const id = (e as DragEvent).dataTransfer?.getData('text/plain');
      const target = zone.dataset.dropzone as Status | undefined;
      if (!id || !target) return;
      // soltar na coluna concluído usa o endpoint complete (grava completed_at).
      if (target === 'done') complete(id);
      else setStatus(id, target);
    });
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
load();

export {};
