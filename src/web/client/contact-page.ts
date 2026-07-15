// Página própria de um contato (/app/contacts/:id — spec 50-console-v2/56). SSR
// (contact-page.ts) só manda o shell + esqueleto; este bundle hidrata os 3 dados
// via fetch nos proxies same-origin do Brain (contacts-data.ts → service binding
// pro Worker expert-contacts): entity, neighbors (1º/2º nível) e timeline paginada.
//
// Labels de contato (tipo/relação) vêm do módulo compartilhado
// src/util/contact-labels.ts (mesma tradução do painel em graph.ts);
// EVENT_KIND_LABELS de src/util/event-kind-labels.ts (onda 6) — home/journal
// usam a MESMA tradução.

import { esc } from '../../util/html.js';
import { domainColor } from '../domain-colors.js';
import { EVENT_KIND_LABELS } from '../../util/event-kind-labels.js';
import { CONTACT_TYPE_LABELS, contactRelLabel } from '../../util/contact-labels.js';
const MANUAL_EVENT_KINDS: Array<{ value: string; label: string }> = [
  { value: 'met', label: 'Encontro' },
  { value: 'talked', label: 'Conversa' },
  { value: 'meeting', label: 'Reunião' },
  { value: 'email', label: 'E-mail' },
  { value: 'message', label: 'Mensagem' },
  { value: 'note', label: 'Nota' },
];
const CONTACT_EVENTS_PAGE_SIZE = 20;

function formatContactEventTs(ts: string, source?: string | null): string {
  if (!ts) return '';
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 16);
  try {
    const opts: Intl.DateTimeFormatOptions = { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' };
    // Backfill do WhatsApp (10.415 eventos, verificado 10/07): a fonte extraída só
    // tinha o DIA da conversa — a hora foi gravada como 12:00 BRT fixo. Hora
    // sintética não é informação: nesses eventos, exibe só a data.
    const syntheticNoon = source === 'whatsapp' &&
      d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }) === '12:00:00';
    if (!syntheticNoon) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return d.toLocaleString('pt-BR', opts);
  } catch {
    return ts.slice(0, 16);
  }
}
function contactEventToSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

interface EntityField { label: string; value: string; href?: string; primary?: boolean; }
interface EntityDetail {
  ok?: boolean;
  error?: string;
  title?: string;
  kind?: string;
  fields?: EntityField[];
  img?: string;
  editable?: { category?: string; last_contacted?: string };
}
interface NeighborItem {
  id: string; label: string; kind: string; edge: 'explicit' | 'similar';
  rel?: string; why?: string; strength?: number; score?: number;
}
interface NeighborLevel2Item extends NeighborItem { via_id: string; via_label: string; }
interface NeighborsResponse {
  ok?: boolean;
  ego?: { id: string; label: string; kind: string };
  level1?: NeighborItem[];
  level2?: NeighborLevel2Item[];
  similar_available?: boolean;
}

function contactHref(id: string): string {
  return `/app/contacts/${encodeURIComponent(id)}`;
}

function renderNotFound(container: HTMLElement): void {
  container.innerHTML = `
    <h1>Contato não encontrado</h1>
    <p><a href="/app/contacts">← Voltar pros contatos</a></p>
  `;
}

// Exportada só pro teste jsdom (test/client/contact-cartela.test.ts) — a página
// real chama via main() na hidratação.
export function renderHeaderAndCartela(container: HTMLElement, id: string, detail: EntityDetail): void {
  const name = detail.title || 'Contato';
  const kind = detail.kind || 'other';
  const category = detail.editable?.category?.trim();
  const lastContacted = detail.editable?.last_contacted?.trim();
  const avatar = typeof detail.img === 'string' && detail.img.startsWith('/media/')
    ? `<img class="contact-page-avatar" src="/app/contacts${esc(detail.img)}" alt="" loading="lazy">`
    : `<div class="contact-page-avatar-fallback" aria-hidden="true"></div>`;

  const kindChip = `<span class="panel-chip" style="--chip:${domainColor(kind)}">${esc(CONTACT_TYPE_LABELS[kind] ?? kind)}</span>`;
  const categoryChip = category ? `<span class="panel-chip">${esc(category)}</span>` : '';
  const lastContactedChip = lastContacted ? `<span class="panel-degree">Último contato: ${esc(lastContacted)}</span>` : '';

  // Rótulo repetido N vezes (ex.: um field "Grupo em comum" POR grupo, vindo do
  // worker de contatos) vira UM bloco só de chips com quebra de linha — pedido
  // 10/07: "tem que dar pra ver que é um bloquinho só de grupos".
  const PLURAL_LABELS: Record<string, string> = { 'Grupo em comum': 'Grupos em comum' };
  const fieldsArr = detail.fields ?? [];
  const labelCounts = new Map<string, number>();
  for (const f of fieldsArr) labelCounts.set(f.label, (labelCounts.get(f.label) ?? 0) + 1);
  const grouped = new Set<string>();
  const fields = fieldsArr.map((f) => {
    if ((labelCounts.get(f.label) ?? 1) > 1) {
      if (grouped.has(f.label)) return ''; // já emitido no bloco do primeiro
      grouped.add(f.label);
      const chips = fieldsArr.filter((x) => x.label === f.label).map((x) => x.href
        ? `<a class="contact-page-chip" href="${esc(x.href)}" target="_blank" rel="noopener">${esc(x.value)}</a>`
        : `<span class="contact-page-chip">${esc(x.value)}</span>`).join('');
      return `
    <div class="contact-page-field">
      <dt>${esc(PLURAL_LABELS[f.label] ?? f.label)}</dt>
      <dd><div class="contact-page-chips">${chips}</div></dd>
    </div>`;
    }
    return `
    <div class="contact-page-field">
      <dt>${esc(f.label)}${f.primary ? ' ★' : ''}</dt>
      <dd>${f.href ? `<a href="${esc(f.href)}" target="_blank" rel="noopener">${esc(f.value)}</a>` : esc(f.value)}</dd>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="contact-page-header">
      ${avatar}
      <div>
        <h1 class="contact-page-name">${esc(name)}</h1>
        <div class="contact-page-meta">${kindChip}${categoryChip}${lastContactedChip}</div>
      </div>
    </div>
    <div class="contact-page-actions">
      <a class="panel-open" href="/app/contacts?focus=${encodeURIComponent(id)}">Abrir no grafo →</a>
    </div>
    <div class="contact-page-section">
      <h2>Cartela</h2>
      <dl class="contact-page-fields">${fields || '<p class="contact-page-empty">Sem campos cadastrados.</p>'}</dl>
    </div>
    <div class="contact-page-section" data-section="group-graph" hidden></div>
    <div class="contact-page-section" data-section="neighbors">
      <h2>Vínculos</h2>
      <p class="contact-page-empty">Carregando vínculos...</p>
    </div>
    <div class="contact-page-section" data-section="mention-notes">
      <h2>Notas sobre esta pessoa</h2>
      <p class="contact-page-empty">Carregando...</p>
    </div>
    <div class="contact-page-section" data-section="mention-tasks">
      <h2>Tarefas com esta pessoa</h2>
      <p class="contact-page-empty">Carregando...</p>
    </div>
    <div class="contact-page-section" data-section="timeline">
      <h2>Interações</h2>
    </div>
  `;
}

// Menções reversas (spec 62 §4): notas de conhecimento + tasks abertas que mencionam
// este contato, dados 100% Brain-local (GET /app/contacts/entity/mentions).
interface MentionNote { id: string; title: string; kind: string | null; private?: boolean; url: string; }
interface MentionTask { id: string; title: string; status: string | null; due_at: number | null; priority: number | null; private?: boolean; url: string; }
interface MentionsResponse { ok?: boolean; notes?: MentionNote[]; tasks_open?: MentionTask[]; tasks_closed_count?: number; }

// Seções de menção VAZIAS somem da página (pedido 10/07: bloco em branco não
// aparece); com conteúdo viram acordeon fechado com a contagem no summary.
function renderMentionNotes(section: HTMLElement, notes: MentionNote[]): void {
  if (notes.length === 0) {
    section.hidden = true;
    section.innerHTML = '';
    return;
  }
  section.hidden = false;
  section.innerHTML = `
    <details class="contact-page-acc">
      <summary>Notas sobre esta pessoa (${notes.length})</summary>
      <div class="contact-page-acc-body">
        <div class="contact-page-vinculos">${notes.map((n) => `
        <a class="panel-conn" href="${esc(n.url)}">
          <span class="panel-conn-label">${esc(n.title)}${n.private ? ' 🔒' : ''}</span>
          <span class="panel-conn-rel">${esc(n.kind || 'nota')}</span>
        </a>`).join('')}</div>
      </div>
    </details>`;
}

function renderMentionTasks(section: HTMLElement, tasks: MentionTask[], closedCount: number): void {
  if (tasks.length === 0 && closedCount === 0) {
    section.hidden = true;
    section.innerHTML = '';
    return;
  }
  section.hidden = false;
  const body = tasks.length
    ? `<div class="contact-page-vinculos">${tasks.map((t) => `
        <a class="panel-conn" href="${esc(t.url)}">
          <span class="panel-conn-label">${esc(t.title)}${t.private ? ' 🔒' : ''}</span>
          <span class="panel-conn-rel">${esc(t.status || 'open')}</span>
        </a>`).join('')}</div>`
    : '<p class="contact-page-empty">Nenhuma tarefa aberta com esta pessoa.</p>';
  const closed = closedCount > 0
    ? `<p class="contact-page-warn">+ ${closedCount} tarefa${closedCount === 1 ? '' : 's'} concluída${closedCount === 1 ? '' : 's'}.</p>`
    : '';
  section.innerHTML = `
    <details class="contact-page-acc">
      <summary>Tarefas com esta pessoa (${tasks.length})</summary>
      <div class="contact-page-acc-body">${body}${closed}</div>
    </details>`;
}

function neighborLine(n: NeighborItem): string {
  const detail = n.edge === 'explicit'
    ? `<span class="panel-conn-rel">${esc(contactRelLabel(n.rel ?? ''))}</span>${n.why ? `<span class="panel-conn-why">${esc(n.why)}</span>` : ''}`
    : `<span class="panel-conn-rel">similar · ${Math.round((n.score ?? 0) * 100)}%</span>`;
  return `<a class="panel-conn" href="${esc(contactHref(n.id))}">
    <span class="panel-conn-label">${esc(n.label)}</span>${detail}
  </a>`;
}

function renderNeighbors(section: HTMLElement, data: NeighborsResponse): void {
  const level1 = data.level1 ?? [];
  const level2 = data.level2 ?? [];
  const explicit1 = level1.filter((n) => n.edge === 'explicit');
  const similar1 = level1.filter((n) => n.edge === 'similar');

  const explicitBlock = explicit1.length
    ? `<div class="contact-page-vinculos">${explicit1.map(neighborLine).join('')}</div>`
    : '<p class="contact-page-empty">Nenhum vínculo explícito ainda.</p>';

  const similarBlock = data.similar_available === false
    ? '<p class="contact-page-warn">Similaridade pendente de pré-computo.</p>'
    : similar1.length
      ? `<div class="contact-page-vinculos">${similar1.map(neighborLine).join('')}</div>`
      : '<p class="contact-page-empty">Nenhum vínculo semelhante encontrado.</p>';

  // 2º nível agrupado por via_label (design 50-console-v2/56 §3.6).
  const groups = new Map<string, NeighborLevel2Item[]>();
  for (const item of level2) {
    const key = item.via_label || item.via_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const level2Html = groups.size
    ? [...groups.entries()].map(([via, items]) => `
        <div class="contact-page-via-group">
          <div class="contact-page-via-label">via ${esc(via)}</div>
          <div class="contact-page-vinculos">${items.map(neighborLine).join('')}</div>
        </div>
      `).join('')
    : '<p class="contact-page-empty">Sem rede de 2º nível ainda.</p>';

  // Acordeons (pedido 10/07): lista longa esconde a página inteira — só os
  // Explícitos curtos (<=6) abrem por padrão; Similares e Rede de 2º nível
  // nascem fechados com a contagem no summary.
  section.innerHTML = `
    <h2>Vínculos</h2>
    <details class="contact-page-acc"${explicit1.length > 0 && explicit1.length <= 6 ? ' open' : ''}>
      <summary>Explícitos (${explicit1.length})</summary>
      <div class="contact-page-acc-body">${explicitBlock}</div>
    </details>
    <details class="contact-page-acc">
      <summary>Similares (${similar1.length})</summary>
      <div class="contact-page-acc-body">${similarBlock}</div>
    </details>
    <details class="contact-page-acc">
      <summary>Rede de 2º nível (${level2.length})</summary>
      <div class="contact-page-acc-body">${level2Html}</div>
    </details>
  `;
  // Navegação contato→contato é via <a href> real (troca de URL + histórico do
  // navegador funciona nativamente) — nenhum JS de roteamento é necessário aqui.
}

function initTimeline(entityId: string, container: HTMLElement): void {
  const state = { offset: 0, total: 0, loading: false };

  container.innerHTML = `
    <ul class="panel-events" data-timeline-list></ul>
    <button type="button" class="panel-timeline-more" data-timeline-more style="display:none">Carregar mais</button>
    <details class="panel-addconn">
      <summary class="panel-addconn-summary">Registrar interação</summary>
      <form class="panel-form" data-timeline-form>
        <div class="panel-form-field">
          <label class="panel-form-label">Tipo</label>
          <select class="panel-form-input" data-timeline-kind>
            ${MANUAL_EVENT_KINDS.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}
          </select>
        </div>
        <div class="panel-form-field">
          <label class="panel-form-label">Contexto (opcional)</label>
          <textarea class="panel-form-textarea" rows="3" maxlength="2000" data-timeline-context placeholder="Sobre o que foi..."></textarea>
        </div>
        <div class="panel-form-field">
          <label class="panel-form-label">Quando (opcional, padrão agora)</label>
          <input type="datetime-local" class="panel-form-input" data-timeline-when />
        </div>
        <div class="panel-form-feedback" role="status" data-timeline-feedback></div>
        <button type="submit" class="panel-form-submit" data-timeline-submit>Registrar</button>
      </form>
    </details>
  `;

  const list = container.querySelector('[data-timeline-list]') as HTMLUListElement;
  const moreBtn = container.querySelector('[data-timeline-more]') as HTMLButtonElement;
  const form = container.querySelector('[data-timeline-form]') as HTMLFormElement;
  const kindSel = container.querySelector('[data-timeline-kind]') as HTMLSelectElement;
  const ctxArea = container.querySelector('[data-timeline-context]') as HTMLTextAreaElement;
  const whenInput = container.querySelector('[data-timeline-when]') as HTMLInputElement;
  const feedback = container.querySelector('[data-timeline-feedback]') as HTMLElement;
  const submitBtn = container.querySelector('[data-timeline-submit]') as HTMLButtonElement;

  function renderItem(ev: { kind: string; ts: string; context?: string | null }): string {
    return `<li>
      <span class="panel-event-kind">${esc(EVENT_KIND_LABELS[ev.kind] ?? ev.kind)}</span>
      <span class="panel-event-ts">${esc(formatContactEventTs(ev.ts))}</span>
      ${ev.context ? `<div class="panel-event-ctx">${esc(ev.context)}</div>` : ''}
    </li>`;
  }

  async function loadPage(): Promise<void> {
    if (state.loading) return;
    state.loading = true;
    moreBtn.disabled = true;
    moreBtn.textContent = 'Carregando...';
    try {
      const res = await fetch(
        `/app/contacts/entity/events?id=${encodeURIComponent(entityId)}&offset=${state.offset}&limit=${CONTACT_EVENTS_PAGE_SIZE}`,
        { credentials: 'same-origin' },
      );
      const d: any = res.ok ? await res.json() : null;
      if (!d || d.ok === false) {
        moreBtn.style.display = 'none';
        if (state.offset === 0) list.innerHTML = '<li class="panel-empty">Erro ao carregar interações.</li>';
        return;
      }
      state.total = d.total ?? 0;
      const events = Array.isArray(d.events) ? d.events : [];
      if (state.offset === 0 && events.length === 0) {
        list.innerHTML = '<li class="panel-empty">Nenhuma interação registrada ainda.</li>';
      } else {
        list.insertAdjacentHTML('beforeend', events.map(renderItem).join(''));
      }
      state.offset += events.length;
      moreBtn.style.display = state.offset < state.total ? '' : 'none';
      moreBtn.textContent = 'Carregar mais';
    } catch {
      moreBtn.style.display = 'none';
    } finally {
      moreBtn.disabled = false;
      state.loading = false;
    }
  }

  moreBtn.addEventListener('click', () => void loadPage());
  void loadPage();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    feedback.textContent = '';
    feedback.classList.remove('error', 'ok');
    const ctxVal = ctxArea.value.trim();
    const body: { entity_id: string; kind: string; context?: string; ts?: string } = {
      entity_id: entityId,
      kind: kindSel.value,
    };
    if (ctxVal) body.context = ctxVal;
    if (whenInput.value) {
      const dt = new Date(whenInput.value);
      if (!Number.isNaN(dt.getTime())) body.ts = contactEventToSqliteUtc(dt);
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Registrando...';
    void fetch('/app/contacts/entity/event', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `falha ${res.status}`);
        const emptyMsg = list.querySelector('.panel-empty');
        if (emptyMsg) emptyMsg.remove();
        list.insertAdjacentHTML('afterbegin', renderItem({
          kind: kindSel.value,
          ts: body.ts || contactEventToSqliteUtc(new Date()),
          context: ctxVal || null,
        }));
        state.total += 1;
        state.offset += 1;
        ctxArea.value = '';
        whenInput.value = '';
        feedback.classList.add('ok');
        feedback.textContent = 'Registrado.';
      })
      .catch((err) => {
        feedback.classList.add('error');
        feedback.textContent = `Erro: ${String(err?.message || err)}`;
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Registrar';
      });
  });

  // Ação rápida "> interação" da paleta (spec 66): chegar aqui com
  // #registrar-interacao já expande o <details> e foca o textarea de contexto —
  // sem isso o formulário fica escondido atrás do <summary> "Registrar interação".
  if (location.hash === '#registrar-interacao') {
    const details = container.querySelector<HTMLDetailsElement>('.panel-addconn');
    if (details) {
      details.open = true;
      details.scrollIntoView({ block: 'center' });
      ctxArea.focus();
    }
  }
}

// ── Grafo interno de um GRUPO (spec: pedido 15/07) ──────────────────────────
// Quando o contato é kind='group', mostra os membros + a rede entre eles: um
// mini force-graph em canvas (leve, sem lib — mesma linguagem visual do hero do
// site) + a lista de membros ordenada por grau (mais conectado no topo). Hover
// num nó destaca ele e seus vínculos; clicar abre a página do membro.
interface GroupMember { id: string; label: string; kind: string; degree: number; }
interface GroupEdge { source: string; target: string; type: string; strength: number; }
interface GroupGraphResponse {
  ok?: boolean; is_group?: boolean;
  group?: { id: string; label: string };
  members?: GroupMember[]; edges?: GroupEdge[];
  total_members?: number; truncated?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[1][0] ?? '' : '')).toUpperCase();
}

function renderGroupGraph(section: HTMLElement, data: GroupGraphResponse): void {
  const members = data.members ?? [];
  const edges = data.edges ?? [];
  if (data.is_group === false || members.length === 0) {
    // Não é grupo, ou grupo sem membro visível: some (não polui contato pessoa).
    section.hidden = true;
    section.innerHTML = '';
    return;
  }
  section.hidden = false;
  const trunc = data.truncated
    ? `<p class="contact-page-warn">Mostrando ${members.length} de ${data.total_members} membros (grupo grande).</p>`
    : '';
  const withEdges = edges.length > 0;
  const canvas = withEdges
    ? `<div class="group-graph-canvas-wrap"><canvas class="group-graph-canvas" width="600" height="360" role="img" aria-label="Grafo de conexões entre os membros do grupo"></canvas></div>`
    : `<p class="contact-page-warn">Ainda não há conexões mapeadas entre os membros (o grafo aparece quando houver interações entre eles).</p>`;

  const list = members.map((m) => `
    <a class="group-member" href="${esc(contactHref(m.id))}" data-member-id="${esc(m.id)}">
      <span class="group-member-avatar" aria-hidden="true">${esc(initials(m.label))}</span>
      <span class="group-member-name">${esc(m.label)}</span>
      ${m.degree > 0 ? `<span class="group-member-degree" title="Conexões dentro do grupo">${m.degree}</span>` : ''}
    </a>`).join('');

  section.innerHTML = `
    <h2>Membros <span class="group-count">${data.total_members ?? members.length}</span></h2>
    ${trunc}
    ${canvas}
    <div class="group-member-grid">${list}</div>
  `;

  if (withEdges) {
    const canvasEl = section.querySelector('.group-graph-canvas') as HTMLCanvasElement | null;
    if (canvasEl) drawGroupGraph(canvasEl, members, edges);
  }
}

// Force-graph mínimo em canvas: simulação de molas + repulsão por alguns ticks,
// depois desenha. Sem rAF contínuo — o layout assenta e congela (barato, e um
// grupo é estático). Hover realça o nó e suas arestas; clique navega.
function drawGroupGraph(canvas: HTMLCanvasElement, members: GroupMember[], edges: GroupEdge[]): void {
  const ctx0 = canvas.getContext('2d');
  if (!ctx0) return;
  const ctx = ctx0; // narrowing sobrevive nas closures (paint/handlers)
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 600;
  const H = 360;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  type Node = { id: string; label: string; degree: number; x: number; y: number; vx: number; vy: number; r: number };
  const maxDeg = Math.max(1, ...members.map((m) => m.degree));
  const nodes: Node[] = members.map((m, i) => {
    const ang = (i / members.length) * Math.PI * 2;
    return {
      id: m.id, label: m.label, degree: m.degree,
      x: W / 2 + Math.cos(ang) * (W * 0.28), y: H / 2 + Math.sin(ang) * (H * 0.32),
      vx: 0, vy: 0, r: 5 + (m.degree / maxDeg) * 9,
    };
  });
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const links = edges
    .map((e) => ({ a: idx.get(e.source), b: idx.get(e.target), strength: e.strength }))
    .filter((l): l is { a: number; b: number; strength: number } => l.a !== undefined && l.b !== undefined);

  // Componentes conexos (union-find): o maior fica no palco central; os menores
  // (par isolado, nó sozinho) são ANCORADOS numa faixa lateral própria em vez de
  // escaparem pra um canto pela repulsão. Sem isso, força-dirigido puro joga
  // componente desconexo pra fora do quadro.
  const parent = nodes.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const l of links) { const ra = find(l.a), rb = find(l.b); if (ra !== rb) parent[ra] = rb; }
  const comp = new Map<number, number[]>();
  nodes.forEach((_, i) => { const r = find(i); if (!comp.has(r)) comp.set(r, []); comp.get(r)!.push(i); });
  const groups = [...comp.values()].sort((a, b) => b.length - a.length);
  const mainComp = new Set(groups[0] ?? []);
  // Nós fora do componente principal: fixos numa coluna à direita, empilhados.
  const outside = groups.slice(1).flat();
  const fixed = new Set<number>();
  outside.forEach((ni, k) => {
    nodes[ni].x = W - 46;
    nodes[ni].y = 40 + k * 40;
    fixed.add(ni);
  });

  // Simulação (Fruchterman-Reingold enxuto), N ticks fixos, + gravidade fraca ao
  // centro pra componentes desconexos (ex.: par isolado) não escaparem pro canto.
  // Só o componente principal entra na simulação; a área útil exclui a coluna
  // lateral dos isolados (quando houver) pra não sobrepor.
  const rightMargin = outside.length ? 92 : 8;
  const sim = [...mainComp];
  const cx = (W - rightMargin) / 2, cy = H / 2;
  const AREA = (W - rightMargin) * H;
  const k = Math.sqrt(AREA / Math.max(1, sim.length)) * 0.95;
  for (let iter = 0; iter < 320; iter++) {
    for (const i of sim) {
      let fx = 0, fy = 0;
      for (const j of sim) {
        if (i === j) continue;
        let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        let d = Math.hypot(dx, dy) || 0.01;
        const rep = (k * k) / d;
        fx += (dx / d) * rep; fy += (dy / d) * rep;
      }
      fx += (cx - nodes[i].x) * 0.045;
      fy += (cy - nodes[i].y) * 0.045;
      nodes[i].vx = fx; nodes[i].vy = fy;
    }
    for (const l of links) {
      if (fixed.has(l.a) || fixed.has(l.b)) continue;
      let dx = nodes[l.a].x - nodes[l.b].x, dy = nodes[l.a].y - nodes[l.b].y;
      let d = Math.hypot(dx, dy) || 0.01;
      const att = (d * d) / k;
      const ux = (dx / d) * att, uy = (dy / d) * att;
      nodes[l.a].vx -= ux; nodes[l.a].vy -= uy;
      nodes[l.b].vx += ux; nodes[l.b].vy += uy;
    }
    const damp = 0.09 * (1 - iter / 320);
    for (const i of sim) {
      const n = nodes[i];
      n.x += Math.max(-16, Math.min(16, n.vx * damp));
      n.y += Math.max(-16, Math.min(16, n.vy * damp));
      n.x = Math.max(n.r + 8, Math.min(W - rightMargin - n.r, n.x));
      n.y = Math.max(n.r + 8, Math.min(H - n.r - 8, n.y));
    }
  }

  const adj = new Map<number, Set<number>>();
  links.forEach((l) => {
    if (!adj.has(l.a)) adj.set(l.a, new Set());
    if (!adj.has(l.b)) adj.set(l.b, new Set());
    adj.get(l.a)!.add(l.b); adj.get(l.b)!.add(l.a);
  });

  let hover = -1;
  function paint(): void {
    ctx.clearRect(0, 0, W, H);
    // arestas
    for (const l of links) {
      const on = hover === -1 || hover === l.a || hover === l.b;
      ctx.strokeStyle = on ? 'rgba(167,139,250,0.42)' : 'rgba(167,139,250,0.08)';
      ctx.lineWidth = on && hover !== -1 ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(nodes[l.a].x, nodes[l.a].y); ctx.lineTo(nodes[l.b].x, nodes[l.b].y); ctx.stroke();
    }
    // nós
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const near = hover === -1 || hover === i || adj.get(hover)?.has(i);
      ctx.globalAlpha = near ? 1 : 0.3;
      ctx.fillStyle = hover === i ? '#c4b5fd' : 'rgba(167,139,250,0.9)';
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      if (hover === i || (hover === -1 && n.r > 9)) {
        ctx.globalAlpha = near ? 0.95 : 0.3;
        ctx.fillStyle = '#e9e4fb';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label, n.x, n.y - n.r - 5);
      }
    }
    ctx.globalAlpha = 1;
  }
  paint();

  function nodeAt(mx: number, my: number): number {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (Math.hypot(nodes[i].x - mx, nodes[i].y - my) <= nodes[i].r + 4) return i;
    }
    return -1;
  }
  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const hit = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (hit !== hover) { hover = hit; canvas.style.cursor = hit >= 0 ? 'pointer' : 'default'; paint(); }
  });
  canvas.addEventListener('mouseleave', () => { if (hover !== -1) { hover = -1; paint(); } });
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const hit = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (hit >= 0) window.location.href = contactHref(nodes[hit].id);
  });
}

async function main(): Promise<void> {
  const container = document.querySelector('.contact-page') as HTMLElement | null;
  if (!container) return;
  const id = container.dataset.contactId;
  if (!id) return;

  let detail: EntityDetail;
  try {
    const res = await fetch(`/app/contacts/entity?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    detail = res.ok ? await res.json() : { ok: false };
  } catch {
    detail = { ok: false };
  }
  if (!detail || detail.ok === false) {
    renderNotFound(container);
    return;
  }

  renderHeaderAndCartela(container, id, detail);

  // Grafo interno do grupo (só renderiza se o contato for kind='group'; o
  // endpoint responde is_group:false pra pessoa/empresa e a seção some).
  const groupSection = container.querySelector('[data-section="group-graph"]') as HTMLElement | null;
  if (groupSection) {
    void fetch(`/app/contacts/entity/group-graph?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: GroupGraphResponse | null) => {
        if (!d || d.ok === false) { groupSection.hidden = true; return; }
        renderGroupGraph(groupSection, d);
      })
      .catch(() => { groupSection.hidden = true; });
  }

  const neighborsSection = container.querySelector('[data-section="neighbors"]') as HTMLElement | null;
  if (neighborsSection) {
    void fetch(`/app/contacts/entity/neighbors?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: NeighborsResponse | null) => {
        if (!d || d.ok === false) {
          neighborsSection.innerHTML = '<h2>Vínculos</h2><p class="contact-page-empty">Vínculos indisponíveis no momento.</p>';
          return;
        }
        renderNeighbors(neighborsSection, d);
      })
      .catch(() => {
        neighborsSection.innerHTML = '<h2>Vínculos</h2><p class="contact-page-empty">Vínculos indisponíveis no momento.</p>';
      });
  }

  // Seções reversas de menção (spec 62 §4): notas + tasks que mencionam este contato.
  const notesSection = container.querySelector('[data-section="mention-notes"]') as HTMLElement | null;
  const tasksSection = container.querySelector('[data-section="mention-tasks"]') as HTMLElement | null;
  if (notesSection || tasksSection) {
    void fetch(`/app/contacts/entity/mentions?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MentionsResponse | null) => {
        if (notesSection) {
          if (!d || d.ok === false) notesSection.innerHTML = '<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indisponível no momento.</p>';
          else renderMentionNotes(notesSection, d.notes ?? []);
        }
        if (tasksSection) {
          if (!d || d.ok === false) tasksSection.innerHTML = '<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indisponível no momento.</p>';
          else renderMentionTasks(tasksSection, d.tasks_open ?? [], d.tasks_closed_count ?? 0);
        }
      })
      .catch(() => {
        if (notesSection) notesSection.innerHTML = '<h2>Notas sobre esta pessoa</h2><p class="contact-page-empty">Indisponível no momento.</p>';
        if (tasksSection) tasksSection.innerHTML = '<h2>Tarefas com esta pessoa</h2><p class="contact-page-empty">Indisponível no momento.</p>';
      });
  }

  const timelineSection = container.querySelector('[data-section="timeline"]') as HTMLElement | null;
  if (timelineSection) initTimeline(id, timelineSection);
}

main().catch((err) => console.error('contact-page: fatal', err));
