// Shell-level client: unified command palette (Ctrl/Cmd+K) with:
//   - Plain query  → fuzzy-searches notes (title + tldr, instant) + tasks + contacts
//                    (server-side, grouped) — Enter navigates.
//   - `> query`    → fuzzy-searches commands (Go to graph, Go to notes, Log out, ...)
//                    OR a quick action (`task <título>`, `capturar <texto>`,
//                    `interação <nome>`) when the text matches one of those prefixes.
// Plus global keyboard shortcuts on every page: Ctrl+G, Ctrl+N, Ctrl+,.
//
// Backed by /app/graph/meta (notes metadata, piggybacked with graph/notes pages) +
// /app/search/all (spec 50-console-v2/66: agregador notas+tasks+contatos).

import Fuse from 'fuse.js';
import { appFetch } from './http.js';
import { loadMeta, type NoteMeta } from './meta-cache.js';
import { toast } from './toast.js';
import { wireAjaxForms } from './ajax-form.js';
import { confirmModal } from './confirm-modal.js';
import { SHORTCUT_DEFS, shortcutsModalHtml } from './shortcuts.js';

interface Command {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

const COMMANDS: Command[] = [
  { id: 'go-home',   label: 'Ir pro Início',        action: () => (window.location.href = '/app') },
  { id: 'go-graph',  label: 'Ir pro Grafo',         hint: 'Ctrl+G', action: () => (window.location.href = '/app/graph') },
  { id: 'go-notes',  label: 'Ir pras Notas',        hint: 'Ctrl+N', action: () => (window.location.href = '/app/notes') },
  { id: 'go-tasks',  label: 'Ir pras Tarefas',      hint: 'Ctrl+T', action: () => (window.location.href = '/app/tasks') },
  { id: 'go-contacts', label: 'Ir pros Contatos',   action: () => (window.location.href = '/app/contacts') },
  // O dashboard fundiu na home (19/07) — o comando leva pra âncora do card.
  { id: 'go-insights', label: 'Ir pras Estatísticas', action: () => (window.location.href = '/app#estatisticas') },
  { id: 'go-config', label: 'Ir pras Configurações', hint: 'Ctrl+,', action: () => (window.location.href = '/app/config') },
  // Único caminho de trocar tema no CELULAR (a sidebar com o botão some ≤767px).
  { id: 'toggle-theme', label: 'Alternar tema (auto → claro → escuro)', action: () => cycleTheme() },
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
// Resultado da busca de notas mostrado na paleta: instantâneo (Fuse local, título +
// tldr) e depois ampliado pelos hits do agregador server-side (/app/search/all —
// título + resumo + CORPO via FTS5). NoteHit é o subconjunto de NoteMeta usado no
// render (id/title/kind) — NoteMeta[] é atribuível aqui sem cast.
interface NoteHit { id: string; title: string; kind: string | null; }
let noteHits: NoteHit[] = [];
let fuseNotes: Fuse<NoteMeta> | null = null;
const fuseCommands = new Fuse(COMMANDS, {
  keys: ['label'],
  threshold: 0.4,
  ignoreLocation: true,
});

// Tasks e contatos (spec 66) não têm índice local — só existem depois do round-trip
// pro agregador. `contactsDegraded` espelha o `degraded: ['contacts']` da resposta
// (grupo permanece visível com aviso, em vez de sumir — critério "contatos fora do
// ar não quebra os demais grupos").
interface TaskHit { id: string; title: string; status: string | null; due_brt: string | null; }
interface ContactHit { id: string; name: string; category: string | null; }
let taskHits: TaskHit[] = [];
let contactHits: ContactHit[] = [];
let contactsDegraded = false;

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
    // (com query digitada, a busca local instantânea de notas passa a funcionar).
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
        <input class="cmd-input" type="search" enterkeyhint="search" placeholder="Buscar notas, tarefas e contatos — digite &gt; pra comandos" autocomplete="off" spellcheck="false" aria-label="Paleta de comandos" />
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
  kind: 'note' | 'task' | 'contact' | 'command' | 'action';
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

interface Section {
  header: string;
  items: ResultItem[];
  message?: string; // linha não-selecionável (ex.: "contatos indisponíveis")
}

let lastResults: ResultItem[] = [];
let cursor = 0;

// ── Recentes (spec 66): últimos itens ABERTOS pela paleta (nota/task/contato — não
// comandos de navegação/ação), persistidos em localStorage. Mostrados no estado zero
// (input vazio) junto com a lista de comandos.
interface RecentItem { kind: 'note' | 'task' | 'contact'; id: string; label: string; hint?: string; href: string; }
const RECENT_KEY = 'eb_cmd_recent';
const RECENT_MAX = 5;

function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(item: RecentItem): void {
  try {
    const cur = loadRecent().filter((r) => !(r.kind === item.kind && r.id === item.id));
    cur.unshift(item);
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_MAX)));
  } catch {
    /* privado/quota: ignora — recentes são cosméticos, nunca bloqueiam a navegação */
  }
}

// Abre um resultado (nota/task/contato): grava em recentes e navega. Único ponto de
// navegação pros 3 tipos — mantém pushRecent + href sempre em sincronia.
function openItem(kind: 'note' | 'task' | 'contact', id: string, label: string, hint: string | undefined, href: string): void {
  pushRecent({ kind, id, label, hint, href });
  window.location.href = href;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  open: 'aberta', in_progress: 'em andamento', done: 'concluída', canceled: 'cancelada',
};
function taskStatusLabel(status: string | null): string | undefined {
  if (!status) return undefined;
  return TASK_STATUS_LABELS[status] ?? status;
}

function kindIcon(kind: ResultItem['kind']): string {
  switch (kind) {
    case 'command': return '⌘';
    case 'task': return '✅';
    case 'contact': return '👤';
    case 'action': return '⚡';
    case 'note':
    default: return '📝';
  }
}

// ── Ações rápidas (spec 66 §2): estendem o sistema de comandos `>` que já existe.
// Reconhecidas por PREFIXO + argumento não-vazio; sem argumento (ex.: usuário ainda
// digitando "task") cai no fuzzy search normal de COMMANDS (que já casa "Tarefas").
function parseQuickAction(q: string): ResultItem | null {
  const taskMatch = /^task\s+(.+)$/i.exec(q);
  if (taskMatch) {
    const title = taskMatch[1].trim();
    if (!title) return null;
    return {
      kind: 'action', id: 'action-task', label: `Criar tarefa: "${title}"`, hint: 'Enter',
      action: () => void createTaskAndNavigate(title),
    };
  }
  const capturarMatch = /^capturar\s+(.+)$/i.exec(q);
  if (capturarMatch) {
    const text = capturarMatch[1].trim();
    if (!text) return null;
    return {
      kind: 'action', id: 'action-capturar', label: `Capturar: "${text}"`, hint: 'Enter',
      action: () => void captureAndNavigate(text),
    };
  }
  const interacaoMatch = /^intera[cç][aã]o\s+(.+)$/i.exec(q);
  if (interacaoMatch) {
    const term = interacaoMatch[1].trim();
    if (!term) return null;
    return {
      kind: 'action', id: 'action-interacao', label: `Registrar interação com "${term}"`, hint: 'Enter',
      action: () => void findContactAndOpenInteraction(term),
    };
  }
  return null;
}

// `> task <título>` → POST /app/tasks/create (endpoint existente da UI, spec 36) e
// navega pro board já com o card focado (?task=<id> — ver src/web/client/tasks.ts).
async function createTaskAndNavigate(title: string): Promise<void> {
  try {
    const res = await appFetch('/app/tasks/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error('create ' + res.status);
    const data = (await res.json()) as { id: string };
    pushRecent({ kind: 'task', id: data.id, label: title, href: `/app/tasks?task=${data.id}` });
    window.location.href = `/app/tasks?task=${encodeURIComponent(data.id)}`;
  } catch (err) {
    console.warn('palette: criação de tarefa falhou', err);
    toast('Não deu pra criar a tarefa. Tenta de novo.');
  }
}

// `> capturar <texto>` → POST /app/inbox/add (spec 63; form-encoded + redirect, é a
// MESMA rota do quick-add da página de inbox). appFetch segue o 302 e devolve a
// página final — res.ok (200) confirma que a captura foi gravada.
async function captureAndNavigate(text: string): Promise<void> {
  try {
    const form = new FormData();
    form.set('text', text);
    const res = await appFetch('/app/inbox/add', { method: 'POST', body: form });
    if (!res.ok) throw new Error('capture ' + res.status);
    window.location.href = '/app/inbox';
  } catch (err) {
    console.warn('palette: captura pro inbox falhou', err);
    toast('Não deu pra capturar no inbox. Tenta de novo.');
  }
}

// `> interação <nome>` → resolve o contato via /app/contacts/search (spec 62, já
// existente) e navega pra página dele com o form de "Registrar interação" (spec 57)
// já expandido e focado (ver src/web/client/contact-page.ts, hash #registrar-interacao).
async function findContactAndOpenInteraction(term: string): Promise<void> {
  try {
    const res = await appFetch('/app/contacts/search?q=' + encodeURIComponent(term));
    if (!res.ok) throw new Error('contacts/search ' + res.status);
    const data = (await res.json()) as { ok?: boolean; results?: Array<{ id: string }> };
    const first = data.results?.[0];
    if (!first) {
      console.warn('palette: nenhum contato encontrado para', term);
      toast(`Nenhum contato encontrado para "${term}".`);
      return;
    }
    window.location.href = `/app/contacts/${encodeURIComponent(first.id)}#registrar-interacao`;
  } catch (err) {
    console.warn('palette: busca de contato pra interação falhou', err);
    toast('Busca de contato falhou. Tenta de novo.');
  }
}

function render(query: string, list: HTMLElement) {
  const isCommand = query.trim().startsWith('>');
  const q = isCommand ? query.trim().slice(1).trim() : query.trim();

  const sections: Section[] = [];

  if (isCommand) {
    const quick = parseQuickAction(q);
    if (quick) {
      sections.push({ header: 'Ação rápida', items: [quick] });
    } else {
      const pool = q ? fuseCommands.search(q).map((r) => r.item) : COMMANDS;
      sections.push({
        header: 'Comandos',
        items: pool.slice(0, 10).map((c) => ({ kind: 'command', id: c.id, label: c.label, hint: c.hint, action: c.action })),
      });
    }
  } else if (!q) {
    // Estado zero (spec 66 §2): últimos itens abertos pela paleta + comandos
    // disponíveis — em vez da lista bruta das 10 primeiras notas de antes.
    const recentItems: ResultItem[] = loadRecent().map((r) => ({
      kind: r.kind, id: r.id, label: r.label, hint: r.hint,
      action: () => (window.location.href = r.href),
    }));
    if (recentItems.length) sections.push({ header: 'Recentes', items: recentItems });
    sections.push({
      header: 'Comandos',
      items: COMMANDS.map((c) => ({ kind: 'command', id: c.id, label: c.label, hint: c.hint, action: c.action })),
    });
  } else {
    const noteItems: ResultItem[] = noteHits.slice(0, 12).map((n) => ({
      kind: 'note', id: n.id, label: n.title, hint: n.kind || undefined,
      action: () => openItem('note', n.id, n.title, n.kind || undefined, `/app/notes/${encodeURIComponent(n.id)}`),
    }));
    if (noteItems.length) sections.push({ header: 'Notas', items: noteItems });

    const taskItems: ResultItem[] = taskHits.slice(0, 6).map((t) => ({
      kind: 'task', id: t.id, label: t.title, hint: t.due_brt || taskStatusLabel(t.status),
      action: () => openItem('task', t.id, t.title, t.due_brt || undefined, `/app/tasks?task=${encodeURIComponent(t.id)}`),
    }));
    if (taskItems.length) sections.push({ header: 'Tarefas', items: taskItems });

    if (contactsDegraded) {
      // Critério "contacts fora do ar": grupo permanece visível com aviso — notas e
      // tarefas acima continuam funcionando normalmente.
      sections.push({ header: 'Contatos', items: [], message: 'contatos indisponíveis' });
    } else {
      const contactItems: ResultItem[] = contactHits.slice(0, 6).map((c) => ({
        kind: 'contact', id: c.id, label: c.name, hint: c.category || undefined,
        action: () => openItem('contact', c.id, c.name, c.category || undefined, `/app/contacts/${encodeURIComponent(c.id)}`),
      }));
      if (contactItems.length) sections.push({ header: 'Contatos', items: contactItems });
    }
  }

  lastResults = sections.flatMap((s) => s.items);
  cursor = 0;

  if (lastResults.length === 0 && !sections.some((s) => s.message)) {
    list.innerHTML = `<li class="cmd-empty">Nada encontrado</li>`;
    return;
  }

  let idx = 0;
  list.innerHTML = sections
    .map((s) => {
      const headerHtml = `<li class="cmd-group-header" role="presentation">${escText(s.header)}</li>`;
      if (s.items.length === 0) {
        return s.message ? `${headerHtml}<li class="cmd-empty cmd-empty-inline">${escText(s.message)}</li>` : '';
      }
      const rows = s.items
        .map((it) => {
          const i = idx++;
          return `
          <li class="cmd-row ${i === 0 ? 'active' : ''}" role="option" data-index="${i}">
            <span class="cmd-kind cmd-kind-${it.kind}">${kindIcon(it.kind)}</span>
            <span class="cmd-label">${escText(it.label)}</span>
            ${it.hint ? `<span class="cmd-hint">${escText(it.hint)}</span>` : ''}
          </li>`;
        })
        .join('');
      return headerHtml + rows;
    })
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
  // A lupa da sidebar (.side-search) expande na caixinha enquanto a palette
  // está aberta — o CSS observa body.palette-open.
  document.body.classList.add('palette-open');
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
  document.body.classList.remove('palette-open');
}

// Busca unificada da paleta (spec 66): notas + tasks + contatos num request só via
// /app/search/all. Notas aqui só AMPLIAM o Fuse local instantâneo (mesmo racional do
// searchNotes antigo — full-text no CORPO, que o Fuse local não cobre); tasks e
// contatos não têm índice local, então só aparecem depois deste round-trip.
interface ServerNoteHit { id: string; title: string; kind: string | null; domain: string; }
interface SearchAllResponse {
  notes: ServerNoteHit[];
  tasks: TaskHit[];
  contacts: ContactHit[];
  degraded?: string[];
}

async function searchAll(q: string): Promise<SearchAllResponse | null> {
  try {
    const res = await appFetch('/app/search/all?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('search/all ' + res.status);
    return (await res.json()) as SearchAllResponse;
  } catch (err) {
    console.warn('palette: busca unificada falhou (notas caem no Fuse local; tasks/contatos ficam vazios)', err);
    return null;
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
    // Instantâneo: Fuse local (título + resumo) — sem esperar a rede. Tasks/contatos
    // ficam com o valor da busca anterior até o debounce resolver (evita "piscar"
    // vazio a cada tecla — mesmo racional do antigo searchNotes pro corpo das notas).
    noteHits = fuseNotes ? fuseNotes.search(q, { limit: 12 }).map((r) => r.item) : [];
    render(val, list);
    // Background: amplia notas com matches do CORPO (server FTS) e busca tasks/contatos.
    if (searchT) window.clearTimeout(searchT);
    searchT = window.setTimeout(async () => {
      const mySeq = ++searchSeq;
      const serverAll = await searchAll(q);
      if (mySeq !== searchSeq) return;
      if (serverAll) {
        const seen = new Set(serverAll.notes.map((n) => n.id));
        const localExtra = (fuseNotes ? fuseNotes.search(q, { limit: 12 }).map((r) => r.item) : [])
          .filter((n) => !seen.has(n.id));
        noteHits = [...serverAll.notes, ...localExtra].slice(0, 12);
        taskHits = serverAll.tasks;
        contactHits = serverAll.contacts;
        contactsDegraded = !!serverAll.degraded?.includes('contacts');
      } else {
        // Falha de rede no agregador inteiro (raro): notas seguem no Fuse local já
        // atribuído acima; tasks/contatos não têm fallback local, então esvaziam.
        taskHits = [];
        contactHits = [];
        contactsDegraded = false;
      }
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

// Binds dirigidos por SHORTCUT_DEFS (spec 91/97) — a MESMA lista gera o modal
// de ajuda ("?"): atalho novo entra em shortcuts.ts + uma ação aqui.
const SHORTCUT_ACTIONS: Record<string, () => void> = {
  palette: () => { if (open) close(); else openPalette(); },
  sidebar: () => toggleSidebar(),
  help: () => toggleShortcutsModal(),
  graph: () => { window.location.href = '/app/graph'; },
  notes: () => { window.location.href = '/app/notes'; },
  tasks: () => { window.location.href = '/app/tasks'; },
  config: () => { window.location.href = '/app/config'; },
};

function onKey(e: KeyboardEvent) {
  const meta = e.ctrlKey || e.metaKey;
  // Ctrl+K é especial: funciona até com a palette aberta (toggle) e digitando.
  if (meta && e.key.toLowerCase() === 'k') {
    // Na página do grafo o bundle do grafo é DONO do Ctrl+K (palette própria de
    // busca de nós) — sem este guard abriam as DUAS empilhadas disputando foco
    // (revisão 19/07). O grafo faz o próprio preventDefault.
    if (document.getElementById('graph-canvas')) return;
    e.preventDefault();
    SHORTCUT_ACTIONS.palette();
    return;
  }
  if (open) return;
  if (isTypingInInput()) return;
  for (const s of SHORTCUT_DEFS) {
    if (s.id === 'palette') continue;
    const keyMatch = s.key.length === 1 && /[a-z]/.test(s.key) ? e.key.toLowerCase() === s.key : e.key === s.key;
    if (keyMatch && (s.meta ? meta : !meta)) {
      e.preventDefault();
      SHORTCUT_ACTIONS[s.id]?.();
      return;
    }
  }
}

// ─────────────── Modal de atalhos "?" (spec 91/97) ───────────────
let shortcutsModal: HTMLDivElement | null = null;

function toggleShortcutsModal() {
  if (shortcutsModal) { closeShortcutsModal(); return; }
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const modal = document.createElement('div');
  modal.className = 'modal shortcuts-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Atalhos do teclado');
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-dialog shortcuts-dialog">
      <div class="modal-head"><strong>Atalhos do teclado</strong><button class="modal-x" type="button" aria-label="Fechar">✕</button></div>
      <div class="modal-body">${shortcutsModalHtml(isMac)}</div>
    </div>`;
  modal.querySelector('.modal-backdrop')!.addEventListener('click', closeShortcutsModal);
  modal.querySelector('.modal-x')!.addEventListener('click', closeShortcutsModal);
  document.addEventListener('keydown', onShortcutsEsc, true);
  document.body.appendChild(modal);
  shortcutsModal = modal;
}

function closeShortcutsModal() {
  shortcutsModal?.remove();
  shortcutsModal = null;
  document.removeEventListener('keydown', onShortcutsEsc, true);
}

function onShortcutsEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.stopPropagation(); closeShortcutsModal(); }
}

function wireSidebarToggle() {
  const btn = document.querySelector('.sidebar-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => toggleSidebar());
}

// ─────────────── Menu do usuário no rodapé da sidebar (19/07) ───────────────
// O bloco do usuário virou botão (avatar + nome) que abre um popover PRA CIMA
// com Configurações / Tema / Trocar foto / Sair. O popover é position:fixed e é
// ancorado aqui no clique (o <aside> tem overflow-y:auto — um absolute mais
// largo que a régua de 60px do modo recolhido seria clipado). Fecha com Esc e
// clique-fora (mesmo padrão do popover de tags do board, client/tasks.ts).
function wireUserMenu() {
  const btn = document.getElementById('sidebar-user-btn');
  const pop = document.getElementById('sidebar-user-pop');
  if (!btn || !pop) return;

  const onOutside = (e: MouseEvent) => {
    const t = e.target as Node | null;
    if (t && !pop.contains(t) && !btn.contains(t)) closeMenu();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      btn.focus();
    }
  };

  function closeMenu() {
    if (pop!.hidden) return;
    pop!.hidden = true;
    btn!.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  function openMenu() {
    // Âncora: acima do botão, alinhado à esquerda dele (clampado na viewport).
    const r = btn!.getBoundingClientRect();
    pop!.style.left = `${Math.max(8, Math.round(r.left))}px`;
    pop!.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
    pop!.hidden = false;
    btn!.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onEsc, true);
  }

  btn.addEventListener('click', () => {
    if (pop.hidden) openMenu(); else closeMenu();
  });
  // Navegar por um item (link/Sair) fecha; o Tema fica aberto de propósito —
  // dá pra ver o rótulo ciclar (auto → claro → escuro) sem reabrir o menu.
  pop.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement | null)?.closest?.('.sidebar-pop-item');
    if (item && !item.hasAttribute('data-theme-toggle')) closeMenu();
  });
}

// Gatilhos sem teclado da palette (spec 91/93): botão "Buscar" da sidebar e lupa
// da bottom-nav, ambos marcados com data-cmd-open no shell SSR. Delegação no
// document — funciona em toda página sem depender da ordem de boot.
function wireSearchTriggers() {
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest?.('[data-cmd-open]');
    if (!btn) return;
    e.preventDefault();
    if (open) close(); else openPalette();
  });
}

// CTA proxy dos empty states (spec 91/92): botão marcado com
// data-click-proxy="<id>" dispara o click do elemento com aquele id (ex.: o
// "Criar primeira nota" reusa o fluxo do botão "+ Nova nota" já wireado pelo
// bundle da página) — CSP-safe, sem duplicar lógica de modal.
function wireClickProxies() {
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest?.('[data-click-proxy]') as HTMLElement | null;
    if (!btn) return;
    const target = document.getElementById(btn.dataset.clickProxy ?? '');
    if (!target || target === btn) return;
    e.preventDefault();
    target.click();
  });
}

// ─────────────── Tema claro/escuro (spec 91/96) ───────────────
// O theme-boot.js (head, bloqueante) já carimbou data-theme no primeiro paint;
// aqui vive o resto: toggle na sidebar ciclando auto → claro → escuro,
// persistência em localStorage.theme, meta theme-color dinâmico, e os listeners
// que mantêm 'auto' colado no SO (matchMedia) e as abas em sincronia (storage).
type ThemePref = 'auto' | 'light' | 'dark';
const THEME_COLORS = { dark: '#070a13', light: '#f6f7fb' }; // espelhos de THEME_COLOR/_LIGHT (styles.ts)

function themePref(): ThemePref {
  try {
    const p = localStorage.getItem('theme');
    return p === 'light' || p === 'dark' ? p : 'auto';
  } catch { return 'auto'; }
}

function applyTheme(pref: ThemePref) {
  const sys = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const mode: 'light' | 'dark' = pref === 'auto' ? sys : pref;
  document.documentElement.setAttribute('data-theme', mode);
  // Com escolha explícita os dois metas apontam pra mesma cor (o media do meta
  // claro deixaria o SO mandar); em auto o par media/default volta a decidir.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.content = pref === 'auto'
      ? (m.media ? THEME_COLORS.light : THEME_COLORS.dark)
      : THEME_COLORS[mode];
  });
  const label = document.querySelector('[data-theme-label]');
  if (label) label.textContent = pref === 'auto' ? 'Tema: auto' : pref === 'light' ? 'Tema: claro' : 'Tema: escuro';
}

// Ciclo auto → claro → escuro — usado pelo botão da sidebar E pelo comando da
// paleta (única rota no celular, onde a sidebar não existe).
function cycleTheme() {
  const next: ThemePref = ({ auto: 'light', light: 'dark', dark: 'auto' } as const)[themePref()];
  try { localStorage.setItem('theme', next); } catch { /* modo privado etc. */ }
  applyTheme(next);
}

function wireThemeToggle() {
  applyTheme(themePref()); // sincroniza label/metas com o que o boot carimbou
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest?.('[data-theme-toggle]');
    if (!btn) return;
    cycleTheme();
  });
  // auto acompanha o SO sem reload; storage sincroniza a escolha entre abas.
  window.matchMedia?.('(prefers-color-scheme: light)')
    .addEventListener?.('change', () => { if (themePref() === 'auto') applyTheme('auto'); });
  window.addEventListener('storage', (e) => { if (e.key === 'theme') applyTheme(themePref()); });
}

// Undo pós-exclusão (spec 91/95): a rota de delete volta pra lista com
// ?deleted=<id>&dtitle=<título>. Aqui a URL é limpa na hora (replaceState — F5
// não re-dispara o toast) e sobe o toast de 8s com "Desfazer", que chama a rota
// de restore e recarrega. É por isso que excluir nota não pede confirm.
function wireUndoToast() {
  const params = new URLSearchParams(location.search);
  const deletedId = params.get('deleted');
  if (!deletedId || !/^[A-Za-z0-9_-]+$/.test(deletedId)) return;
  const title = params.get('dtitle') ?? '';
  params.delete('deleted');
  params.delete('dtitle');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  toast(title ? `Nota "${title}" excluída.` : 'Nota excluída.', 'ok', {
    action: {
      label: 'Desfazer',
      onClick: () => {
        void fetch(`/app/notes/${deletedId}/restore`, {
          method: 'POST',
          headers: { accept: 'application/json' },
        }).then((res) => {
          if (res.ok) location.reload();
          else toast('Não consegui restaurar a nota.', 'error');
        }).catch(() => toast('Não consegui restaurar a nota.', 'error'));
      },
    },
  });
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
wireUserMenu();
wireSearchTriggers();
wireClickProxies();
wireAjaxForms();
wireUndoToast();
wireThemeToggle();
// Ponte pro bundle-string do config (spec 95): configPageScript() não importa
// módulo ES, então o confirmModal chega lá via window (com fallback nativo).
(window as unknown as { __ebConfirm?: typeof confirmModal }).__ebConfirm = confirmModal;
// Descartar captura do inbox é destrutivo (o anexo sai do R2 quando é a última
// referência) e não tem undo na UI — e os botões são forms server-rendered em
// DUAS páginas (home + /app/inbox). A confirmação entra aqui por delegação:
// o shell é o único bundle garantido nas duas. Sem JS, o form segue direto
// (comportamento antigo) — a confirmação é progressive enhancement.
document.addEventListener('submit', (e) => {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  if (!form || !form.action.endsWith('/app/inbox/resolve')) return;
  if (form.querySelector<HTMLInputElement>('input[name="action"]')?.value !== 'discard') return;
  if (form.dataset.confirmed === '1') return;
  e.preventDefault();
  void confirmModal({
    title: 'Descartar esta captura?',
    body: 'Ela sai do inbox e o anexo (se houver) é apagado — não dá pra desfazer.',
    verb: 'Descartar',
  }).then((ok) => {
    if (!ok) return;
    form.dataset.confirmed = '1';
    form.requestSubmit();
  });
});
window.addEventListener('keydown', onKey);
// loadNotes() removido do boot (spec 23): o meta agora carrega lazy na 1ª abertura
// da palette (ensureNotesLoaded via openPalette). Páginas sem busca visível não
// baixam mais o /app/graph/meta à toa.
registerServiceWorker();
wireInstallCta();

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

// CTA de instalação do PWA (specs/50-console-v2/68): o browser só dispara
// `beforeinstallprompt` quando o app é instalável e ainda não foi instalado —
// capturamos o evento aqui (shell roda em toda página) e, se a página tiver o
// botão #pwa-install-btn (card "Instalar como app" na config), ele aparece.
// iOS não tem esse evento: a instrução manual do card cobre (SSR, sem JS).
let deferredInstall: (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null = null;

function updateInstallCta() {
  const btn = document.getElementById('pwa-install-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const status = document.getElementById('pwa-install-status');
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (standalone) {
    btn.hidden = true;
    if (status) status.textContent = 'O app já está instalado — você está usando ele agora.';
    return;
  }
  btn.hidden = !deferredInstall;
}

function wireInstallCta() {
  const btn = document.getElementById('pwa-install-btn') as HTMLButtonElement | null;
  if (!btn) return;
  updateInstallCta();
  btn.addEventListener('click', async () => {
    const ev = deferredInstall;
    if (!ev) return;
    deferredInstall = null;
    btn.hidden = true;
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      if (choice.outcome === 'accepted') toast('App instalado.', 'ok');
      else updateInstallCta();
    } catch (err) {
      console.warn('pwa: install prompt falhou', err);
    }
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e as typeof deferredInstall;
  updateInstallCta();
});

// ── Web Push (specs/50-console-v2/68): card "Notificações" da config. O estado dos
// botões deriva da assinatura REAL do dispositivo (pushManager.getSubscription), não
// de flag no servidor. Sem suporte do browser ou sem VAPID no servidor, o card
// explica em texto e não mostra botão nenhum.
function b64urlToUint8(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function wirePushCard(): Promise<void> {
  const enableBtn = document.getElementById('push-enable-btn') as HTMLButtonElement | null;
  const disableBtn = document.getElementById('push-disable-btn') as HTMLButtonElement | null;
  const testBtn = document.getElementById('push-test-btn') as HTMLButtonElement | null;
  const status = document.getElementById('push-status');
  if (!enableBtn || !disableBtn || !testBtn) return;

  const setStatus = (msg: string) => { if (status) status.textContent = msg; };

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    setStatus('Este navegador não suporta notificações push. No iPhone/iPad, instale o app primeiro (Compartilhar → Adicionar à Tela de Início).');
    return;
  }

  // Permissão já BLOQUEADA no navegador: o botão "Ativar" não teria efeito
  // nenhum (o prompt nem abre). Esconde o botão e ensina onde desbloquear.
  if (Notification.permission === 'denied') {
    enableBtn.hidden = true;
    setStatus('As notificações estão bloqueadas pra este site no navegador. Pra liberar: clique no cadeado ao lado do endereço → Notificações → Permitir, e recarregue esta página.');
    return;
  }

  let vapidKey: string | null = null;
  try {
    const res = await appFetch('/app/push/vapid-key');
    if (res.ok) vapidKey = ((await res.json()) as { key: string | null }).key;
  } catch { /* trata como não configurado abaixo */ }
  if (!vapidKey) {
    setStatus('As notificações ainda não foram configuradas no servidor — peça ao seu assistente pra configurar o push (chave VAPID) e recarregue esta página.');
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const current = await reg.pushManager.getSubscription();
  const showSubscribed = (on: boolean) => {
    enableBtn.hidden = on;
    disableBtn.hidden = !on;
    testBtn.hidden = !on;
    if (on) setStatus('Notificações ativas neste dispositivo. O aviso diário chega junto com o lembrete de tarefas.');
  };
  showSubscribed(!!current);

  enableBtn.addEventListener('click', async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('Permissão negada. Pra liberar depois: cadeado ao lado do endereço → Notificações → Permitir.');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToUint8(vapidKey!) as unknown as BufferSource,
      });
      const res = await appFetch('/app/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error('subscribe ' + res.status);
      showSubscribed(true);
      toast('Notificações ativadas.', 'ok');
    } catch (err) {
      console.warn('push: ativação falhou', err);
      toast('Não deu pra ativar as notificações. Tenta de novo.');
    }
  });

  disableBtn.addEventListener('click', async () => {
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await appFetch('/app/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      showSubscribed(false);
      setStatus('Notificações desativadas neste dispositivo.');
      toast('Notificações desativadas.', 'ok');
    } catch (err) {
      console.warn('push: desativação falhou', err);
      toast('Não deu pra desativar. Tenta de novo.');
    }
  });

  testBtn.addEventListener('click', async () => {
    try {
      const res = await appFetch('/app/push/test', { method: 'POST' });
      if (!res.ok) throw new Error('test ' + res.status);
      toast('Teste enviado — a notificação deve chegar em alguns segundos.', 'ok');
    } catch (err) {
      console.warn('push: teste falhou', err);
      toast('Não deu pra enviar o teste.');
    }
  });
}

if (document.getElementById('push-notifs')) void wirePushCard();

// ── Web Share Target nível 2 (specs/50-console-v2/68): quando o SO compartilha um
// ARQUIVO, o service worker intercepta o POST /app/inbox/share (que não carrega o
// cookie SameSite=Lax), guarda o blob no Cache API e redireciona pra
// /app/inbox?share=file&title=... — aqui a página resgata o blob e sobe via fetch
// same-origin (cookie flui), criando o item do inbox com o anexo.
const SHARE_CACHE = 'brain-share';
const SHARE_PENDING_URL = '/_share/pending';

async function processSharedFile(): Promise<void> {
  if (window.location.pathname !== '/app/inbox') return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('share') !== 'file') return;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match(SHARE_PENDING_URL);
    if (!res) return; // já processado (refresh) ou cache evicted — o prefill de texto cobre
    const blob = await res.blob();
    const filename = decodeURIComponent(res.headers.get('x-share-filename') || '') || 'compartilhado';
    const text = ['title', 'text', 'url']
      .map((k) => params.get(k)?.trim() || '')
      .filter(Boolean)
      .join('\n\n');
    const form = new FormData();
    form.set('text', text);
    form.set('media', new File([blob], filename, { type: blob.type || 'application/octet-stream' }));
    const up = await appFetch('/app/inbox/share-upload', { method: 'POST', body: form });
    if (!up.ok) throw new Error('share-upload ' + up.status);
    await cache.delete(SHARE_PENDING_URL);
    // Recarrega limpo: o item recém-criado aparece na fila e o prefill some.
    window.location.replace('/app/inbox');
  } catch (err) {
    console.warn('share: upload do arquivo compartilhado falhou', err);
    toast('Não deu pra anexar o arquivo compartilhado. O texto ficou no campo de captura.');
  }
}
void processSharedFile();
