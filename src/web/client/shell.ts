// Shell-level client: unified command palette (Ctrl/Cmd+K) with:
//   - Plain query  → fuzzy-searches all notes (title + tldr), Enter navigates
//   - `> query`    → fuzzy-searches commands (Go to graph, Go to notes, Log out, ...)
// Plus global keyboard shortcuts on every page: Ctrl+G, Ctrl+N, Ctrl+,.
//
// Backed by /app/graph/meta — same payload used by graph and notes pages so
// we piggyback the fetch rather than adding another endpoint.

import Fuse from 'fuse.js';
import { appFetch } from './http.js';
import { loadMeta, type NoteMeta } from './meta-cache.js';

interface Command {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

const COMMANDS: Command[] = [
  { id: 'go-graph',  label: 'Ir pro Grafo',         hint: 'Ctrl+G', action: () => (window.location.href = '/app/graph') },
  { id: 'go-notes',  label: 'Ir pras Notas',        hint: 'Ctrl+N', action: () => (window.location.href = '/app/notes') },
  { id: 'go-tasks',  label: 'Ir pras Tarefas',      hint: 'Ctrl+T', action: () => (window.location.href = '/app/tasks') },
  { id: 'go-config', label: 'Ir pras Configurações', hint: 'Ctrl+,', action: () => (window.location.href = '/app/config') },
  { id: 'toggle-sidebar', label: 'Recolher/expandir menu', hint: 'Ctrl+B', action: () => toggleSidebar() },
  { id: 'logout',    label: 'Sair',                 action: () => submitLogout() },
];

// Recolhe/expande o menu lateral. Persiste em cookie (não localStorage) pra que
// o servidor já renderize o estado certo na próxima página — sem flash.
function setSidebar(collapsed: boolean) {
  const shell = document.querySelector('.shell');
  if (!shell) return;
  shell.classList.toggle('sidebar-collapsed', collapsed);
  const btn = shell.querySelector('.sidebar-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('aria-label', collapsed ? 'Expandir menu' : 'Recolher menu');
  }
  document.cookie = `eb_sidebar=${collapsed ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
}

function toggleSidebar() {
  const shell = document.querySelector('.shell');
  setSidebar(!shell?.classList.contains('sidebar-collapsed'));
}

function submitLogout() {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/app/logout';
  document.body.appendChild(form);
  form.submit();
}

let notes: NoteMeta[] = [];
let notesById = new Map<string, NoteMeta>();
let fuseNotes: Fuse<NoteMeta> | null = null;
// Resultado da última busca de notas no servidor (FTS5: título + resumo + corpo).
let noteHits: NoteMeta[] = [];
const fuseCommands = new Fuse(COMMANDS, {
  keys: ['label'],
  threshold: 0.4,
  ignoreLocation: true,
});

// Carga LAZY do meta (spec 23): não roda mais no boot de toda página. Só é
// disparada quando a palette (Ctrl+K) abre — páginas sem busca visível (tasks,
// config, detalhe) deixam de baixar o meta à toa. loadMeta() memoiza a Promise,
// então se a página também for /app/notes ou /app/graph o fetch é compartilhado.
let notesLoaded = false;
let notesLoading = false;
async function ensureNotesLoaded() {
  if (notesLoaded || notesLoading) return;
  notesLoading = true;
  try {
    notes = await loadMeta();
    notesById = new Map(notes.map((n) => [n.id, n]));
    fuseNotes = new Fuse(notes, {
      keys: [
        { name: 'title', weight: 0.7 },
        { name: 'tldr', weight: 0.3 },
      ],
      threshold: 0.35,
      minMatchCharLength: 2,
      ignoreLocation: true,
    });
    notesLoaded = true;
    // Se a palette já está aberta esperando, re-renderiza agora que os dados chegaram
    // (o empty-state "Notas ainda carregando" cobre a janela de latência).
    const root = document.getElementById('cmd-palette');
    if (open && root) {
      const input = root.querySelector('.cmd-input') as HTMLInputElement | null;
      const list = root.querySelector('.cmd-list') as HTMLElement | null;
      if (input && list) render(input.value, list);
    }
  } catch (err) {
    console.warn('shell: meta load failed', err);
  } finally {
    notesLoading = false;
  }
}

function ensurePalette(): { root: HTMLElement; input: HTMLInputElement; list: HTMLElement; help: HTMLElement } {
  let root = document.getElementById('cmd-palette') as HTMLElement | null;
  if (root) {
    return {
      root,
      input: root.querySelector('.cmd-input') as HTMLInputElement,
      list: root.querySelector('.cmd-list') as HTMLElement,
      help: root.querySelector('.cmd-help') as HTMLElement,
    };
  }

  root = document.createElement('div');
  root.id = 'cmd-palette';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Command palette');
  root.innerHTML = `
    <div class="cmd-backdrop"></div>
    <div class="cmd-dialog">
      <div class="cmd-input-row">
        <span class="cmd-input-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <input class="cmd-input" type="text" placeholder="Buscar notas — digite &gt; pra comandos" autocomplete="off" spellcheck="false" aria-label="Paleta de comandos" />
        <kbd class="cmd-esc">Esc</kbd>
      </div>
      <ul class="cmd-list" role="listbox" aria-live="polite"></ul>
      <div class="cmd-help">
        <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
        <span><kbd>↵</kbd> abrir</span>
        <span><kbd>&gt;</kbd> comandos</span>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const backdrop = root.querySelector('.cmd-backdrop') as HTMLElement;
  backdrop.addEventListener('click', close);

  const input = root.querySelector('.cmd-input') as HTMLInputElement;
  const list = root.querySelector('.cmd-list') as HTMLElement;
  const help = root.querySelector('.cmd-help') as HTMLElement;
  return { root, input, list, help };
}

interface ResultItem {
  kind: 'note' | 'command';
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

let lastResults: ResultItem[] = [];
let cursor = 0;

function render(query: string, list: HTMLElement) {
  const isCommand = query.trim().startsWith('>');
  const q = isCommand ? query.trim().slice(1).trim() : query.trim();

  let items: ResultItem[] = [];
  if (isCommand) {
    const pool = q ? fuseCommands.search(q).map((r) => r.item) : COMMANDS;
    items = pool.slice(0, 10).map((c) => ({
      kind: 'command',
      id: c.id,
      label: c.label,
      hint: c.hint,
      action: c.action,
    }));
  } else {
    if (!q) {
      items = notes.slice(0, 10).map((n) => ({
        kind: 'note',
        id: n.id,
        label: n.title,
        hint: n.kind || undefined,
        action: () => (window.location.href = `/app/notes/${encodeURIComponent(n.id)}`),
      }));
    } else {
      // noteHits é preenchido pela busca server-side (FTS5) no listener de input.
      items = noteHits.slice(0, 12).map((n) => ({
        kind: 'note',
        id: n.id,
        label: n.title,
        hint: n.kind || undefined,
        action: () => (window.location.href = `/app/notes/${encodeURIComponent(n.id)}`),
      }));
    }
  }

  lastResults = items;
  cursor = 0;

  if (items.length === 0) {
    list.innerHTML = `<li class="cmd-empty">${q ? 'Nada encontrado' : 'Notas ainda carregando'}</li>`;
    return;
  }

  list.innerHTML = items
    .map(
      (it, i) => `
      <li class="cmd-row ${i === 0 ? 'active' : ''}" role="option" data-index="${i}">
        <span class="cmd-kind cmd-kind-${it.kind}">${it.kind === 'command' ? '⌘' : '📝'}</span>
        <span class="cmd-label">${escText(it.label)}</span>
        ${it.hint ? `<span class="cmd-hint">${escText(it.hint)}</span>` : ''}
      </li>`
    )
    .join('');
}

function setCursor(delta: number, list: HTMLElement) {
  if (lastResults.length === 0) return;
  cursor = (cursor + delta + lastResults.length) % lastResults.length;
  list.querySelectorAll('.cmd-row').forEach((el, i) => {
    el.classList.toggle('active', i === cursor);
    if (i === cursor) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  });
}

function execute() {
  const it = lastResults[cursor];
  if (!it) return;
  close();
  it.action();
}

let open = false;
function openPalette() {
  const { root, input, list } = ensurePalette();
  open = true;
  root.classList.add('open');
  input.value = '';
  // Dispara a carga do meta na PRIMEIRA abertura da palette (lazy). ensureNotesLoaded
  // re-renderiza a lista quando os dados chegam se a palette ainda estiver aberta.
  void ensureNotesLoaded();
  render('', list);
  setTimeout(() => input.focus(), 0);
}

function close() {
  const root = document.getElementById('cmd-palette');
  if (!root) return;
  open = false;
  root.classList.remove('open');
}

// Busca full-text de notas no servidor (FTS5: título + resumo + corpo). Resolve
// os ids nos metadados já carregados. Fallback pro Fuse local em caso de erro.
async function searchNotes(q: string): Promise<NoteMeta[]> {
  try {
    const res = await appFetch('/app/search?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('search ' + res.status);
    const ids = (await res.json()) as string[];
    return ids.map((id) => notesById.get(id)).filter(Boolean).slice(0, 12) as NoteMeta[];
  } catch (err) {
    console.warn('palette: busca server-side falhou, usando Fuse', err);
    return fuseNotes ? fuseNotes.search(q, { limit: 12 }).map((r) => r.item) : [];
  }
}

function wire() {
  const { input, list } = ensurePalette();
  let searchT: number | null = null;
  let searchSeq = 0;
  input.addEventListener('input', () => {
    const val = input.value;
    // Comandos (> ...) e query vazia: render local instantâneo.
    if (val.trim().startsWith('>') || !val.trim()) {
      render(val, list);
      return;
    }
    const q = val.trim();
    // Instantâneo: Fuse local (título + resumo) — sem esperar a rede.
    noteHits = fuseNotes ? fuseNotes.search(q, { limit: 12 }).map((r) => r.item) : [];
    render(val, list);
    // Background: amplia com matches do CORPO (server FTS), unindo aos locais.
    if (searchT) window.clearTimeout(searchT);
    searchT = window.setTimeout(async () => {
      const mySeq = ++searchSeq;
      const serverHits = await searchNotes(q);
      if (mySeq !== searchSeq || serverHits.length === 0) return;
      const seen = new Set(serverHits.map((n) => n.id));
      const localExtra = (fuseNotes ? fuseNotes.search(q, { limit: 12 }).map((r) => r.item) : [])
        .filter((n) => !seen.has(n.id));
      noteHits = [...serverHits, ...localExtra].slice(0, 12);
      render(val, list);
    }, 130);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(1, list); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(-1, list); }
    else if (e.key === 'Enter') { e.preventDefault(); execute(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.cmd-row') as HTMLElement | null;
    if (!row) return;
    cursor = Number(row.dataset.index ?? 0);
    execute();
  });
}

function isTypingInInput(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el.id === 'cmd-palette' || (el as HTMLElement).closest?.('#cmd-palette')) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}

function onKey(e: KeyboardEvent) {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (open) close(); else openPalette();
    return;
  }
  if (open) return;
  if (isTypingInInput()) return;
  if (meta && e.key.toLowerCase() === 'g') { e.preventDefault(); window.location.href = '/app/graph'; }
  else if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); window.location.href = '/app/notes'; }
  else if (meta && e.key.toLowerCase() === 't') { e.preventDefault(); window.location.href = '/app/tasks'; }
  else if (meta && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (meta && e.key === ',') { e.preventDefault(); window.location.href = '/app/config'; }
}

function wireSidebarToggle() {
  const btn = document.querySelector('.sidebar-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => toggleSidebar());
}

function escText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
    }
    return c;
  });
}

ensurePalette();
wire();
wireSidebarToggle();
window.addEventListener('keydown', onKey);
// loadNotes() removido do boot (spec 23): o meta agora carrega lazy na 1ª abertura
// da palette (ensureNotesLoaded via openPalette). Páginas sem busca visível não
// baixam mais o /app/graph/meta à toa.
registerServiceWorker();

// Service worker — registra /sw.js após load pra cachear shell estático.
// Não muda nada visual; só permite Add to Home Screen e abre mais rápido em
// revisita. Falha silenciosa em ambientes sem suporte.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('sw register failed', err));
  });
}
