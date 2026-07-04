// Notes list client: fetches /app/graph/meta (same payload as graph slide panel)
// and powers client-side fuzzy search, multi-select filter chips, sort, and
// compact/card layout toggle. SSR list is replaced with this richer view once
// the bundle boots — the server-rendered list is the no-JS fallback.

import Fuse from 'fuse.js';
import { DOMAIN_COLORS, domainColor } from '../domain-colors.js';
import { appFetch } from './http.js';
import { loadMeta, type NoteMeta } from './meta-cache.js';

type SortKey = 'updated_desc' | 'title_asc' | 'kind';
type Layout = 'cards' | 'compact';

const KIND_ORDER = ['concept', 'decision', 'insight', 'fact', 'pattern', 'principle', 'question'];

// Janela de render (spec 23): renderiza no máximo N cards no DOM por vez + botão
// "Mostrar mais". Evita re-parsear ~1800 nós por keystroke. Reset a cada mudança
// de query/filtro/sort (busca nova = janela nova).
const RENDER_WINDOW = 200;

async function main() {
  const listEl = document.getElementById('notes-list');
  const searchEl = document.getElementById('notes-search-input') as HTMLInputElement | null;
  const domainsEl = document.getElementById('notes-domain-chips');
  const kindsEl = document.getElementById('notes-kind-chips');
  const sortEl = document.getElementById('notes-sort') as HTMLSelectElement | null;
  const layoutEl = document.getElementById('notes-layout') as HTMLSelectElement | null;
  const countEl = document.getElementById('notes-count');
  if (!listEl) return;

  // updated_at agora vem do próprio meta (campo aditivo, spec 23) — não mais do DOM
  // SSR, que com paginação só teria as 100 primeiras notas e quebraria o sort do resto.
  let notes: NoteMeta[] = [];
  try {
    notes = await loadMeta();
  } catch (err) {
    console.error('notes: meta load failed', err);
    return; // SSR list stays — degraded mode
  }

  // O link SSR "Carregar mais" (no-JS fallback) é substituído pela janela de
  // render client-side + botão "Mostrar mais". Remove pra não duplicar.
  document.getElementById('notes-load-more')?.remove();

  const notesById = new Map(notes.map((n) => [n.id, n]));

  // Fuse fica como fallback client-side (título/tldr) caso o endpoint server-side
  // de busca full-text falhe. O caminho normal busca no servidor (título + resumo
  // + CORPO via FTS5), que o Fuse não alcança porque o corpo não é enviado pro client.
  const fuse = new Fuse(notes, {
    keys: [
      { name: 'title', weight: 0.6 },
      { name: 'tldr', weight: 0.3 },
      { name: 'id', weight: 0.1 },
    ],
    threshold: 0.35,
    minMatchCharLength: 2,
    ignoreLocation: true,
  });

  const state = {
    query: '',
    // Resultado da busca server-side (notas ranqueadas pelo FTS) ou null quando
    // não há query. apply() usa isso em vez de filtrar `notes` localmente.
    searchResults: null as NoteMeta[] | null,
    domainFilter: new Set<string>(),
    kindFilter: new Set<string>(),
    sort: (sortEl?.value as SortKey) ?? 'updated_desc',
    layout: ((layoutEl?.value as Layout) ?? 'cards'),
    // Janela de render — quantos cards despejar no DOM. Cresce pelo botão "Mostrar
    // mais"; reseta a cada mudança de query/filtro/sort.
    renderLimit: RENDER_WINDOW,
  };

  // Assinatura (ids na ordem) do último pool efetivamente renderizado — usada pra
  // NÃO re-renderizar quando a busca de fundo (server FTS) devolve o mesmo conjunto.
  let lastRenderedSig = '';

  // Reseta a janela e re-renderiza. Chamado por toda mudança de query/filtro/sort.
  function resetWindow() {
    state.renderLimit = RENDER_WINDOW;
    apply();
  }

  // Busca full-text no servidor; resolve os ids retornados (já ranqueados) nos
  // metadados que o client tem em memória. Fallback pro Fuse local se falhar.
  async function runSearch(q: string): Promise<NoteMeta[]> {
    try {
      const res = await appFetch('/app/search?q=' + encodeURIComponent(q));
      if (!res.ok) throw new Error('search ' + res.status);
      const ids = (await res.json()) as string[];
      return ids.map((id) => notesById.get(id)).filter(Boolean) as NoteMeta[];
    } catch (err) {
      console.warn('notes: busca server-side falhou, usando Fuse local', err);
      return fuse.search(q).map((r) => r.item);
    }
  }

  renderChips();
  apply();

  if (searchEl) {
    let t: number | null = null;
    let seq = 0; // descarta respostas fora de ordem (digitação rápida)
    searchEl.addEventListener('input', () => {
      if (t) window.clearTimeout(t);
      const q = searchEl.value.trim();
      state.query = q;
      if (!q) {
        state.searchResults = null;
        resetWindow();
        return;
      }
      // Instantâneo: Fuse local (título + resumo) — sem esperar a rede.
      state.searchResults = fuse.search(q).map((r) => r.item);
      resetWindow();
      // Background: amplia com matches do CORPO (server FTS), unindo aos locais.
      // O apply() interno só re-renderiza se o conjunto de fato mudou (dedup por
      // assinatura de ids) — evita re-parsear o DOM duas vezes por tecla.
      t = window.setTimeout(async () => {
        const mySeq = ++seq;
        const serverResults = await runSearch(q);
        if (mySeq !== seq) return; // chegou uma busca mais nova, ignora esta
        const seen = new Set(serverResults.map((n) => n.id));
        const localExtra = fuse.search(q).map((r) => r.item).filter((n) => !seen.has(n.id));
        state.searchResults = [...serverResults, ...localExtra];
        apply();
      }, 140);
    });
    // Global `/` shortcut focuses search
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && !isTypingInInput()) {
        e.preventDefault();
        searchEl.focus();
      }
      if (e.key === 'Escape' && document.activeElement === searchEl) {
        searchEl.blur();
      }
    });
  }
  if (sortEl) {
    sortEl.addEventListener('change', () => {
      state.sort = sortEl.value as SortKey;
      resetWindow();
    });
  }
  if (layoutEl) {
    layoutEl.addEventListener('change', () => {
      state.layout = layoutEl.value as Layout;
      resetWindow();
    });
  }
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Botão "Mostrar mais" — cresce a janela sem resetar (append incremental).
    if (target.id === 'notes-show-more') {
      state.renderLimit += RENDER_WINDOW;
      apply();
      return;
    }
    const chip = target.closest('.notes-chip') as HTMLElement | null;
    if (!chip) return;
    const filter = chip.dataset.filter;
    const value = chip.dataset.value;
    if (!filter || !value) return;
    chip.classList.toggle('active');
    const set = filter === 'domain' ? state.domainFilter : state.kindFilter;
    if (chip.classList.contains('active')) set.add(value);
    else set.delete(value);
    resetWindow();
  });

  function renderChips() {
    if (domainsEl) {
      const counts = new Map<string, number>();
      for (const n of notes) for (const d of n.domains) counts.set(d, (counts.get(d) ?? 0) + 1);
      const known = Object.keys(DOMAIN_COLORS);
      const sorted = [...counts.keys()].sort((a, b) => {
        const ai = known.indexOf(a), bi = known.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
      domainsEl.innerHTML = sorted
        .map(
          (d) => `
          <button class="notes-chip" data-filter="domain" data-value="${esc(d)}">
            <span class="dot" style="background:${domainColor(d)}"></span>
            <span>${esc(d)}</span>
            <span class="count">${counts.get(d)}</span>
          </button>`
        )
        .join('');
    }
    if (kindsEl) {
      const counts = new Map<string, number>();
      for (const n of notes) if (n.kind) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
      const sorted = [...counts.keys()].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
      kindsEl.innerHTML = sorted
        .map(
          (k) => `
          <button class="notes-chip notes-chip-kind" data-filter="kind" data-value="${esc(k)}">
            <span>${esc(k)}</span>
            <span class="count">${counts.get(k)}</span>
          </button>`
        )
        .join('');
    }
  }

  function apply() {
    // Com query: usa o resultado ranqueado da busca server-side (full-text em
    // título + resumo + corpo). Sem query: todas as notas.
    let pool = state.query ? (state.searchResults ?? []) : notes;

    if (state.domainFilter.size > 0) {
      pool = pool.filter((n) => n.domains.some((d) => state.domainFilter.has(d)));
    }
    if (state.kindFilter.size > 0) {
      pool = pool.filter((n) => state.kindFilter.has(n.kind));
    }

    if (!state.query) {
      pool = [...pool].sort((a, b) => {
        if (state.sort === 'updated_desc') return (b.updated_at ?? 0) - (a.updated_at ?? 0);
        if (state.sort === 'title_asc') return a.title.localeCompare(b.title);
        if (state.sort === 'kind') {
          const ki = KIND_ORDER.indexOf(a.kind), kj = KIND_ORDER.indexOf(b.kind);
          if (ki !== kj) return ki - kj;
          return a.title.localeCompare(b.title);
        }
        return 0;
      });
    }

    if (countEl) countEl.textContent = `${pool.length} ${pool.length === 1 ? 'note' : 'notes'}`;

    if (listEl!.dataset.layout !== state.layout) {
      listEl!.dataset.layout = state.layout;
    }

    if (pool.length === 0) {
      listEl!.innerHTML = `<p class="notes-empty">No notes match your filters.</p>`;
      lastRenderedSig = 'empty';
      syncShowMore(0, 0);
      return;
    }

    // Janela de render: só os primeiros renderLimit cards vão pro DOM. O botão
    // "Mostrar mais" (fora do #notes-list) cresce a janela sem re-parsear tudo.
    const windowed = pool.slice(0, state.renderLimit);

    // Dedup: se o conjunto+ordem+janela renderizados não mudou, não toca no DOM
    // (a busca de fundo frequentemente devolve o mesmo pool que o Fuse local).
    const sig = `${state.layout}|${windowed.length}|${windowed.map((n) => n.id).join(',')}`;
    if (sig === lastRenderedSig) return;
    lastRenderedSig = sig;

    listEl!.innerHTML = windowed.map((n) => card(n, state.layout)).join('');
    syncShowMore(pool.length, state.renderLimit);
  }

  // Mostra/atualiza/esconde o botão "Mostrar mais" logo após #notes-list.
  function syncShowMore(poolLen: number, limit: number) {
    let btn = document.getElementById('notes-show-more') as HTMLButtonElement | null;
    const remaining = poolLen - limit;
    if (remaining > 0) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'notes-show-more';
        btn.className = 'notes-show-more';
        btn.type = 'button';
        listEl!.insertAdjacentElement('afterend', btn);
      }
      btn.textContent = `Mostrar mais (${remaining} restantes)`;
    } else if (btn) {
      btn.remove();
    }
  }

  function card(n: NoteMeta, layout: Layout): string {
    const domainBadges = n.domains
      .map((d) => `<span class="badge" style="--chip:${domainColor(d)}">${esc(d)}</span>`)
      .join('');
    const kindBadge = n.kind ? `<span class="kind-badge">${esc(n.kind)}</span>` : '';
    const updated = n.updated_at ? formatDate(n.updated_at) : '';

    if (layout === 'compact') {
      return `
        <a class="note-row" href="/app/notes/${encodeURIComponent(n.id)}" data-note-id="${esc(n.id)}">
          <span class="note-row-title">${esc(n.title)}</span>
          <span class="note-row-meta">${kindBadge}${domainBadges}<span class="note-row-date">${updated}</span></span>
        </a>`;
    }
    const tldr = n.tldr ? `<div class="note-card-tldr">${esc(n.tldr)}</div>` : '';
    return `
      <a class="note-card" href="/app/notes/${encodeURIComponent(n.id)}" data-note-id="${esc(n.id)}">
        <div class="note-card-head">${kindBadge}<span class="note-card-date">${updated}</span></div>
        <div class="title">${esc(n.title)}</div>
        ${tldr}
        <div class="meta">${domainBadges}</div>
      </a>`;
  }
}

function isTypingInInput(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}

function esc(s: string): string {
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

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

main().catch((err) => console.error('notes client: fatal', err));
