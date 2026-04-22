// Notes list client: fetches /app/graph/meta (same payload as graph slide panel)
// and powers client-side fuzzy search, multi-select filter chips, sort, and
// compact/card layout toggle. SSR list is replaced with this richer view once
// the bundle boots — the server-rendered list is the no-JS fallback.

import Fuse from 'fuse.js';
import { DOMAIN_COLORS, domainColor } from '../domain-colors.js';

interface NoteMeta {
  id: string;
  title: string;
  kind: string;
  tldr: string;
  domains: string[];
  updated_at?: number;
}

type SortKey = 'updated_desc' | 'title_asc' | 'kind';
type Layout = 'cards' | 'compact';

const KIND_ORDER = ['concept', 'decision', 'insight', 'fact', 'pattern', 'principle', 'question'];

async function main() {
  const listEl = document.getElementById('notes-list');
  const searchEl = document.getElementById('notes-search-input') as HTMLInputElement | null;
  const domainsEl = document.getElementById('notes-domain-chips');
  const kindsEl = document.getElementById('notes-kind-chips');
  const sortEl = document.getElementById('notes-sort') as HTMLSelectElement | null;
  const layoutEl = document.getElementById('notes-layout') as HTMLSelectElement | null;
  const countEl = document.getElementById('notes-count');
  if (!listEl) return;

  // Read updated_at from the SSR list so we don't need a second roundtrip for sort.
  // The SSR list renders `data-updated-at` on each card — we index by id.
  const updatedMap = new Map<string, number>();
  listEl.querySelectorAll('[data-note-id]').forEach((el) => {
    const id = (el as HTMLElement).dataset.noteId ?? '';
    const u = Number((el as HTMLElement).dataset.updatedAt ?? '0');
    if (id) updatedMap.set(id, u);
  });

  let notes: NoteMeta[] = [];
  try {
    const res = await fetch('/app/graph/meta', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`meta ${res.status}`);
    notes = (await res.json()) as NoteMeta[];
    for (const n of notes) n.updated_at = updatedMap.get(n.id) ?? 0;
  } catch (err) {
    console.error('notes: meta load failed', err);
    return; // SSR list stays — degraded mode
  }

  const fuse = new Fuse(notes, {
    keys: [
      { name: 'title', weight: 0.7 },
      { name: 'tldr', weight: 0.3 },
    ],
    threshold: 0.35,
    minMatchCharLength: 2,
    ignoreLocation: true,
  });

  const state = {
    query: '',
    domainFilter: new Set<string>(),
    kindFilter: new Set<string>(),
    sort: (sortEl?.value as SortKey) ?? 'updated_desc',
    layout: ((layoutEl?.value as Layout) ?? 'cards'),
  };

  renderChips();
  apply();

  if (searchEl) {
    let t: number | null = null;
    searchEl.addEventListener('input', () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => {
        state.query = searchEl.value.trim();
        apply();
      }, 80);
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
      apply();
    });
  }
  if (layoutEl) {
    layoutEl.addEventListener('change', () => {
      state.layout = layoutEl.value as Layout;
      apply();
    });
  }
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest('.notes-chip') as HTMLElement | null;
    if (!chip) return;
    const filter = chip.dataset.filter;
    const value = chip.dataset.value;
    if (!filter || !value) return;
    chip.classList.toggle('active');
    const set = filter === 'domain' ? state.domainFilter : state.kindFilter;
    if (chip.classList.contains('active')) set.add(value);
    else set.delete(value);
    apply();
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
    let pool = notes;

    if (state.query) {
      pool = fuse.search(state.query).map((r) => r.item);
    }
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

    listEl!.innerHTML = pool.map((n) => card(n, state.layout)).join('');
    if (pool.length === 0) {
      listEl!.innerHTML = `<p class="notes-empty">No notes match your filters.</p>`;
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
