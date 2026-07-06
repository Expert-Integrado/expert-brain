// Página própria de um contato (/app/contacts/:id — spec 50-console-v2/56). SSR
// (contact-page.ts) só manda o shell + esqueleto; este bundle hidrata os 3 dados
// via fetch nos proxies same-origin do Brain (contacts-data.ts → service binding
// pro Worker expert-contacts): entity, neighbors (1º/2º nível) e timeline paginada.
//
// Cópias inline de labels/formatters de contato (CONTACT_TYPE_LABELS,
// EVENT_KIND_LABELS, etc.) — mesmo racional do painel de contato em graph.ts: este
// bundle não importa o TS do Worker de contatos, e graph.ts é grande/sensível
// demais (força/física/render) pra virar dependência compartilhada aqui.

import { esc } from '../../util/html.js';
import { domainColor } from '../domain-colors.js';

const CONTACT_TYPE_LABELS: Record<string, string> = {
  person: 'Pessoa', company: 'Empresa', place: 'Lugar', event: 'Evento', other: 'Outro',
};

const EVENT_KIND_LABELS: Record<string, string> = {
  met: 'Encontro', talked: 'Conversa', meeting: 'Reunião', email: 'E-mail', message: 'Mensagem',
  note: 'Nota', saw_post: 'Vi post', recommended: 'Indicação', birthday_reminder: 'Aniversário',
  mentioned_in_brain: 'Citado no Brain',
};
const MANUAL_EVENT_KINDS: Array<{ value: string; label: string }> = [
  { value: 'met', label: 'Encontro' },
  { value: 'talked', label: 'Conversa' },
  { value: 'meeting', label: 'Reunião' },
  { value: 'email', label: 'E-mail' },
  { value: 'message', label: 'Mensagem' },
  { value: 'note', label: 'Nota' },
];
const CONTACT_EVENTS_PAGE_SIZE = 20;

function formatContactEventTs(ts: string): string {
  if (!ts) return '';
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 16);
  try {
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
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

function renderHeaderAndCartela(container: HTMLElement, id: string, detail: EntityDetail): void {
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

  const fields = (detail.fields ?? []).map((f) => `
    <div class="contact-page-field">
      <dt>${esc(f.label)}${f.primary ? ' ★' : ''}</dt>
      <dd>${f.href ? `<a href="${esc(f.href)}" target="_blank" rel="noopener">${esc(f.value)}</a>` : esc(f.value)}</dd>
    </div>
  `).join('');

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

function renderMentionNotes(section: HTMLElement, notes: MentionNote[]): void {
  const body = notes.length
    ? `<div class="contact-page-vinculos">${notes.map((n) => `
        <a class="panel-conn" href="${esc(n.url)}">
          <span class="panel-conn-label">${esc(n.title)}${n.private ? ' 🔒' : ''}</span>
          <span class="panel-conn-rel">${esc(n.kind || 'nota')}</span>
        </a>`).join('')}</div>`
    : '<p class="contact-page-empty">Nenhuma nota menciona esta pessoa ainda.</p>';
  section.innerHTML = `<h2>Notas sobre esta pessoa</h2>${body}`;
}

function renderMentionTasks(section: HTMLElement, tasks: MentionTask[], closedCount: number): void {
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
  section.innerHTML = `<h2>Tarefas com esta pessoa</h2>${body}${closed}`;
}

function neighborLine(n: NeighborItem): string {
  const detail = n.edge === 'explicit'
    ? `<span class="panel-conn-rel">${esc(n.rel ?? '')}</span>${n.why ? `<span class="panel-conn-why">${esc(n.why)}</span>` : ''}`
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

  section.innerHTML = `
    <h2>Vínculos</h2>
    <h3 class="contact-page-via-label">Explícitos</h3>
    ${explicitBlock}
    <h3 class="contact-page-via-label">Similares</h3>
    ${similarBlock}
    <div class="contact-page-section">
      <h2>Rede (2º nível)</h2>
      ${level2Html}
    </div>
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
