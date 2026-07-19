// Notes list client: fetches /app/graph/meta (same payload as graph slide panel)
// and powers client-side fuzzy search, multi-select filter chips, sort, and
// compact/card layout toggle. SSR list is replaced with this richer view once
// the bundle boots — the server-rendered list is the no-JS fallback.

import Fuse from 'fuse.js';
import { DOMAIN_COLORS, resolveDomainMeta, resolveKindMeta, type TaxonomyConfig } from '../domain-colors.js';
import { appFetch } from './http.js';
import { loadMeta, type NoteMeta } from './meta-cache.js';
import { loadTaxonomy } from './taxonomy-cache.js';

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
  // Taxonomia (spec 54): aditivo — se falhar, cai no fallback vazio (paleta
  // compilada) sem derrubar a lista de notas.
  const taxonomy: TaxonomyConfig = await loadTaxonomy();

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

  // IntersectionObserver do "Mostrar mais" (scroll infinito) — declarado AQUI, antes
  // da 1ª chamada de apply() logo abaixo: apply()→syncShowMore() já lê esta variável
  // na primeira renderização, e uma `let` só é utilizável DEPOIS do statement que a
  // declara (temporal dead zone) — declará-la perto de syncShowMore (mais abaixo no
  // arquivo) quebrava com "Cannot access before initialization" assim que a lista
  // montava, porque apply() roda antes desse ponto do código ser alcançado.
  let showMoreObserver: IntersectionObserver | null = null;

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
  wireCreateModal();

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
      // spec 54 — áreas pré-criadas na taxonomia (0 notas ainda) aparecem no
      // filtro assim que salvas, sem precisar de nenhuma nota usando o slug.
      for (const slug of Object.keys(taxonomy.domains)) {
        if (!counts.has(slug)) counts.set(slug, 0);
      }
      const known = Object.keys(DOMAIN_COLORS);
      const sorted = [...counts.keys()].sort((a, b) => {
        const ai = known.indexOf(a), bi = known.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
      domainsEl.innerHTML = sorted
        .map((d) => {
          const meta = resolveDomainMeta(d, taxonomy);
          return `
          <button class="notes-chip" data-filter="domain" data-value="${esc(d)}">
            <span class="dot" style="background:${meta.color}"></span>
            <span>${esc(meta.label)}</span>
            <span class="count">${counts.get(d)}</span>
          </button>`;
        })
        .join('');
    }
    if (kindsEl) {
      const counts = new Map<string, number>();
      for (const n of notes) if (n.kind) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
      const sorted = [...counts.keys()].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
      kindsEl.innerHTML = sorted
        .map((k) => {
          const meta = resolveKindMeta(k, taxonomy);
          return `
          <button class="notes-chip notes-chip-kind" data-filter="kind" data-value="${esc(k)}">
            <span>${esc(meta.label)}</span>
            <span class="count">${counts.get(k)}</span>
          </button>`;
        })
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

    // "mostrando X de Y notas de conhecimento" (audit ui-audit/RELATORIO.md item N1/N3):
    // X = quantas o render window vai efetivamente desenhar do pool JÁ filtrado (não do
    // vault inteiro) — filtro/busca ativos mudam Y também, de propósito.
    if (countEl) countEl.textContent = formatCountLabel(Math.min(state.renderLimit, pool.length), pool.length);

    if (listEl!.dataset.layout !== state.layout) {
      listEl!.dataset.layout = state.layout;
    }

    if (pool.length === 0) {
      listEl!.innerHTML = `<p class="notes-empty">Nenhuma nota corresponde aos filtros.</p>`;
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

  // Scroll infinito (audit ui-audit/RELATORIO.md item N1: "rolar até o fim não carrega
  // mais nada"): observa o botão "Mostrar mais" via IntersectionObserver — quando ele
  // entra na viewport (rootMargin antecipa antes de bater no fundo de verdade), cresce
  // a janela sozinho, sem precisar de clique. O botão continua existindo (não é só um
  // sentinel invisível): clique manual e leitor de tela seguem funcionando idêntico a
  // antes — a IntersectionObserver é aditiva, não substitui o fallback. (showMoreObserver
  // é declarada lá em cima, perto de lastRenderedSig — ver o comentário lá.)
  function observeShowMore(btn: HTMLElement) {
    if (typeof IntersectionObserver === 'undefined') return; // sem suporte: só o clique manual funciona
    showMoreObserver?.disconnect();
    showMoreObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          state.renderLimit += RENDER_WINDOW;
          apply();
        }
      }
    }, { rootMargin: '600px 0px' });
    showMoreObserver.observe(btn);
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
        observeShowMore(btn);
      }
      btn.textContent = `Mostrar mais (${remaining} restantes)`;
    } else if (btn) {
      showMoreObserver?.disconnect();
      btn.remove();
    }
  }

  function card(n: NoteMeta, layout: Layout): string {
    const domainBadges = n.domains
      .map((d) => {
        const meta = resolveDomainMeta(d, taxonomy);
        return `<span class="badge" style="--chip:${meta.color}">${esc(meta.label)}</span>`;
      })
      .join('');
    const kindBadge = n.kind
      ? (() => {
          const meta = resolveKindMeta(n.kind, taxonomy);
          return `<span class="kind-badge" style="--chip:${meta.color}">${esc(meta.label)}</span>`;
        })()
      : '';
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

// "+ Nova nota" (audit ui-audit/RELATORIO.md item N2) — modal mínimo (título + corpo
// opcional) espelhando o "Modal 'Nova task'" de client/tasks.ts: POST /app/notes/create
// (título+corpo, ver handleNoteCreatePost em src/web/notes.ts) e navega pra nota nova
// (a lista não tem card local pra atualizar in-place como o board de tasks — o editor
// completo da nota é o próximo passo natural, igual ao redirect do inbox to-note).
function wireCreateModal() {
  const modal = document.getElementById('notes-create-modal');
  const openBtn = document.getElementById('notes-new-btn');
  const form = document.getElementById('notes-create-form') as HTMLFormElement | null;
  if (!modal || !openBtn || !form) return;

  const titleInput = form.querySelector<HTMLInputElement>('#notes-create-title-input');
  const msg = form.querySelector<HTMLElement>('[data-create-msg]');
  const submitBtn = form.querySelector<HTMLButtonElement>('.notes-create-submit');

  function openModal() {
    modal!.hidden = false;
    modal!.setAttribute('aria-hidden', 'false');
    setTimeout(() => titleInput?.focus(), 20);
  }
  function closeModal() {
    modal!.hidden = true;
    modal!.setAttribute('aria-hidden', 'true');
    form!.reset();
    if (msg) { msg.textContent = ''; msg.className = 'notes-create-msg'; }
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
    if (!title) {
      if (msg) { msg.textContent = 'Título é obrigatório'; msg.className = 'notes-create-msg err'; }
      titleInput?.focus();
      return;
    }

    const payload: Record<string, unknown> = { title };
    const bodyVal = String(data.get('body') || '').trim();
    if (bodyVal) payload.body = bodyVal;

    if (submitBtn) submitBtn.disabled = true;
    if (msg) { msg.textContent = 'Criando...'; msg.className = 'notes-create-msg saving'; }
    try {
      const res = await appFetch('/app/notes/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = (await res.json().catch(() => ({}))) as { id?: string; dup?: string | null; error?: string };
      if (!res.ok || !out.id) {
        if (msg) { msg.textContent = 'Erro: ' + (out.error || res.status); msg.className = 'notes-create-msg err'; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      const dupParam = out.dup ? `?dup=${encodeURIComponent(out.dup)}` : '';
      window.location.href = `/app/notes/${encodeURIComponent(out.id)}${dupParam}`;
    } catch (err) {
      if (msg) { msg.textContent = 'Falha de conexão'; msg.className = 'notes-create-msg err'; }
      if (submitBtn) submitBtn.disabled = false;
    }
  });
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

// Espelha o formatDate do SSR (notes.ts): BRT fixo (UTC-3) + DD/MM/YYYY — client
// e server precisam pintar a MESMA data no card (duplicado pela mesma razão dos
// demais helpers: bundles não compartilham módulo com o server).
function formatDate(ts: number): string {
  const d = new Date(ts - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

// Espelha formatCountLabel de src/web/notes.ts (SSR) — mesma regra pt-BR + "notas de
// conhecimento" + "mostrando X de Y" (audit ui-audit/RELATORIO.md itens N1/N3/N4).
// Duplicado (não importado do server) porque client e server bundles não compartilham
// módulo hoje — ver o comentário equivalente no server pela mesma razão de design.
function formatCountLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'nota de conhecimento' : 'notas de conhecimento';
  if (total === 0) return `0 ${noun}`;
  const totalFmt = total.toLocaleString('pt-BR');
  if (shown <= 0 || shown >= total) return `${totalFmt} ${noun}`;
  return `mostrando ${shown.toLocaleString('pt-BR')} de ${totalFmt} ${noun}`;
}

main().catch((err) => console.error('notes client: fatal', err));
