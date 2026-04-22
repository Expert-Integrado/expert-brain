// Shell-level client: unified command palette (Ctrl/Cmd+K) with:
//   - Plain query  → fuzzy-searches all notes (title + tldr), Enter navigates
//   - `> query`    → fuzzy-searches commands (Go to graph, Go to notes, Log out, ...)
// Plus global keyboard shortcuts on every page: Ctrl+G, Ctrl+N, Ctrl+,.
//
// Backed by /app/graph/meta — same payload used by graph and notes pages so
// we piggyback the fetch rather than adding another endpoint.

import Fuse from 'fuse.js';

interface NoteMeta { id: string; title: string; kind: string; tldr: string; domains: string[]; }

interface Command {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

const COMMANDS: Command[] = [
  { id: 'go-graph',  label: 'Go to Graph',  hint: 'Ctrl+G', action: () => (window.location.href = '/app/graph') },
  { id: 'go-notes',  label: 'Go to Notes',  hint: 'Ctrl+N', action: () => (window.location.href = '/app/notes') },
  { id: 'go-config', label: 'Go to Config', hint: 'Ctrl+,', action: () => (window.location.href = '/app/config') },
  { id: 'logout',    label: 'Log out',     action: () => submitLogout() },
];

function submitLogout() {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/app/logout';
  document.body.appendChild(form);
  form.submit();
}

let notes: NoteMeta[] = [];
let fuseNotes: Fuse<NoteMeta> | null = null;
const fuseCommands = new Fuse(COMMANDS, {
  keys: ['label'],
  threshold: 0.4,
  ignoreLocation: true,
});

async function loadNotes() {
  try {
    const res = await fetch('/app/graph/meta', { credentials: 'same-origin' });
    if (!res.ok) return;
    notes = (await res.json()) as NoteMeta[];
    fuseNotes = new Fuse(notes, {
      keys: [
        { name: 'title', weight: 0.7 },
        { name: 'tldr', weight: 0.3 },
      ],
      threshold: 0.35,
      minMatchCharLength: 2,
      ignoreLocation: true,
    });
  } catch (err) {
    console.warn('shell: meta load failed', err);
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
        <input class="cmd-input" type="text" placeholder="Search notes — type &gt; for commands" autocomplete="off" spellcheck="false" aria-label="Command palette input" />
        <kbd class="cmd-esc">Esc</kbd>
      </div>
      <ul class="cmd-list" role="listbox" aria-live="polite"></ul>
      <div class="cmd-help">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>&gt;</kbd> commands</span>
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
    } else if (fuseNotes) {
      items = fuseNotes.search(q, { limit: 12 }).map((r) => ({
        kind: 'note',
        id: r.item.id,
        label: r.item.title,
        hint: r.item.kind || undefined,
        action: () => (window.location.href = `/app/notes/${encodeURIComponent(r.item.id)}`),
      }));
    }
  }

  lastResults = items;
  cursor = 0;

  if (items.length === 0) {
    list.innerHTML = `<li class="cmd-empty">${q ? 'No matches' : 'No notes loaded yet'}</li>`;
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
  render('', list);
  setTimeout(() => input.focus(), 0);
}

function close() {
  const root = document.getElementById('cmd-palette');
  if (!root) return;
  open = false;
  root.classList.remove('open');
}

function wire() {
  const { input, list } = ensurePalette();
  input.addEventListener('input', () => render(input.value, list));
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
  else if (meta && e.key === ',') { e.preventDefault(); window.location.href = '/app/config'; }
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
window.addEventListener('keydown', onKey);
loadNotes();
