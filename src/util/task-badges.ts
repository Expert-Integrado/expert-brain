// Chips de tag e ícone de compartilhamento no card do board (spec 52). Self-
// contido (própria função de escape) pra ser importado tanto pelo SSR
// (src/web/tasks.ts) quanto pelo bundle client (src/web/client/tasks.ts) sem
// depender do esc() de nenhum dos dois lados — render idêntico nos dois.
// Tags reservadas (dedupe:*) NUNCA chegam aqui — o payload já as filtra
// (src/web/tasks.ts buildBoard) antes de montar o TaskView.

function escBadge(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const MAX_VISIBLE_TAGS = 3;

// Até 3 chips + "+N" quando houver mais. tags vazio → string vazia (não polui
// o card sem tags).
export function tagChipsHtml(tags: string[]): string {
  if (tags.length === 0) return '';
  const visible = tags.slice(0, MAX_VISIBLE_TAGS);
  const extra = tags.length - visible.length;
  const chips = visible.map((t) => `<span class="task-tag-chip">${escBadge(t)}</span>`).join('');
  const more = extra > 0 ? `<span class="task-tag-chip task-tag-more">+${extra}</span>` : '';
  return chips + more;
}

// Breadcrumb de projeto no card (Onda 5, specs/60-ux-reforma/66 — anatomia
// ClickUp): contexto muted "Em <projeto>" abaixo do título, no lugar do chip
// colorido no head. A bolinha mantém a cor do projeto; arquivado esmaece.
export function projectCrumbHtml(
  project: { label: string; color: string | null; archived?: boolean } | null
): string {
  if (!project) return '';
  const dot = project.color && /^#[0-9a-fA-F]{6}$/.test(project.color)
    ? ` style="background:${project.color}"`
    : '';
  const cls = project.archived ? 'task-card-crumb archived' : 'task-card-crumb';
  const label = escBadge(project.label);
  return `<div class="${cls}" title="Projeto: ${label}"><span class="task-project-dot"${dot}></span>Em ${label}</div>`;
}

// ─────────── Bolinhas de responsável no card (spec 37) ───────────
// Shape enxuto que o payload do board ecoa (AssigneeRef de queries.ts sem o import,
// pra este módulo continuar folha e importável pelo bundle client).
export interface AssigneeDot { id: string; name: string; type: 'person' | 'agent'; avatar: boolean }

// Cor determinística por id (hash simples → hue) — mesmo usuário, mesma cor em
// qualquer superfície, sem persistir nada.
export function dotHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

// Iniciais: 1ª letra dos dois primeiros nomes ("Ana Almeida" → "AA"; "openclaw" → "O").
export function dotInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const second = parts.length > 1 ? parts[1][0] ?? '' : '';
  return (first + second).toUpperCase();
}

// Chip de claim do card (spec 80-frota-agentes/88/89): quem detém o LEASE de
// trabalho AGORA e até quando. Só claim ATIVO chega aqui (o payload filtra lease
// vencido — livre não renderiza nada). Compartilhado SSR + client, como os demais.
export interface ClaimChip { name: string; expires_brt: string; }

export function claimChipHtml(claim: ClaimChip | null | undefined): string {
  if (!claim) return '';
  return `<span class="task-claim-chip" title="Em trabalho por ${escBadge(claim.name)} — lease até ${escBadge(claim.expires_brt)} (claim_task, spec 88)">⛏ ${escBadge(claim.name)} · ${escBadge(claim.expires_brt)}</span>`;
}

// Banner "Aguardando você" (spec 89): fila de bloqueios da frota pendentes de
// resposta do dono, acima do board. Compartilhado SSR + client (render idêntico).
// Itens chegam ordenados (bloqueio mais antigo primeiro) e com a data já formatada
// — este módulo é folha e não importa util/time. Vazio → string vazia; o CALLER
// esconde/mostra o container.
export interface AwaitingItem {
  id: string;
  title: string;
  block_body: string;
  block_author: string | null;
  block_at_brt: string;
}

const MAX_AWAITING_BODY = 160;

export function awaitingBannerHtml(items: AwaitingItem[]): string {
  if (!items || items.length === 0) return '';
  const rows = items
    .map((it) => {
      const body = it.block_body.length > MAX_AWAITING_BODY
        ? `${it.block_body.slice(0, MAX_AWAITING_BODY)}…`
        : it.block_body;
      const who = it.block_author ? `${it.block_author} · ` : '';
      return `<a class="task-awaiting-item" href="/app/tasks/${escBadge(it.id)}">` +
        `<span class="task-awaiting-title">${escBadge(it.title)}</span>` +
        `<span class="task-awaiting-body">${escBadge(body)}</span>` +
        `<span class="task-awaiting-meta">${escBadge(who)}${escBadge(it.block_at_brt)}</span>` +
        `</a>`;
    })
    .join('');
  return `<div class="task-awaiting-head">⏳ Aguardando você <span class="task-awaiting-count">${items.length}</span></div><div class="task-awaiting-list">${rows}</div>`;
}

const MAX_VISIBLE_DOTS = 3;

// Ícone de pessoa (outline) pro slot vazio — inline pra não depender de asset.
const PERSON_ICON =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<circle cx="8" cy="5.2" r="2.7" stroke="currentColor" stroke-width="1.3"/>' +
  '<path d="M2.8 13.6c.9-2.4 2.9-3.6 5.2-3.6s4.3 1.2 5.2 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

// Até 3 bolinhas (foto quando tem, senão iniciais+cor) + "+N". Agente ganha a
// classe assignee-dot-agent (anel tracejado — diferencia máquina de pessoa).
// Lista vazia → slot VAZIO tracejado ("sem responsável"): o campo aparece SEMPRE
// no card — a premissa do dono é que toda tarefa tem responsável, então a
// ausência precisa ser visível, não invisível (padrão ClickUp).
export function assigneeDotsHtml(assignees: AssigneeDot[]): string {
  if (!assignees || assignees.length === 0) {
    return `<span class="task-assignees" aria-label="Sem responsável"><span class="assignee-dot assignee-dot-empty" title="Sem responsável — atribua no detalhe da task">${PERSON_ICON}</span></span>`;
  }
  const visible = assignees.slice(0, MAX_VISIBLE_DOTS);
  const extra = assignees.length - visible.length;
  const dots = visible
    .map((a) => {
      const title = a.type === 'agent' ? `${a.name} (agente)` : a.name;
      const agentCls = a.type === 'agent' ? ' assignee-dot-agent' : '';
      if (a.avatar) {
        // Fallback pra 404 (usuário sem blob de avatar, ou blob apagado): NÃO dá
        // pra usar onerror="" inline — a CSP do app é script-src 'self' sem
        // unsafe-inline/script-src-attr (ver src/web/render.ts), que bloqueia
        // atributos de evento inline (mesma razão que já bloqueia onclick em
        // notes.ts/config-script.ts). O listener delegado que troca a <img> pela
        // bolinha de iniciais mora em wireAssigneeAvatarFallback() (fim do
        // arquivo), auto-registrado quando este módulo carrega no browser.
        // hue/iniciais viajam em data-attribute pro listener ler no momento do
        // erro, sem precisar recalcular nem embutir texto no HTML gerado aqui.
        return `<img class="assignee-dot${agentCls}" src="/app/users/${escBadge(a.id)}/avatar" alt="${escBadge(title)}" title="${escBadge(title)}" loading="lazy" data-hue="${dotHue(a.id)}" data-initials="${escBadge(dotInitials(a.name))}">`;
      }
      return `<span class="assignee-dot assignee-dot-initials${agentCls}" style="background:hsl(${dotHue(a.id)},42%,36%)" title="${escBadge(title)}" aria-label="${escBadge(title)}">${escBadge(dotInitials(a.name))}</span>`;
    })
    .join('');
  const more = extra > 0 ? `<span class="assignee-dot assignee-dot-initials assignee-dot-more" title="+${extra} responsáveis">+${extra}</span>` : '';
  return `<span class="task-assignees" aria-label="Responsáveis">${dots}${more}</span>`;
}

// ─────────── Badge de progresso do checklist no card (spec 38) ───────────
// "3/8" ao lado do badge de comentários. Shape enxuto (não importa o tipo do
// db/subtasks — módulo folha, compartilhado SSR + client). null/total 0 → vazio.
export interface SubtaskProgressRef { done: number; total: number }

const CHECKLIST_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0;vertical-align:-1px">' +
  '<path d="M3 4.5 4.2 5.7 6.5 3.4M3 8.5 4.2 9.7 6.5 7.4M3 12.5l1.2 1.2 2.3-2.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M9 4.5h4.5M9 8.5h4.5M9 12.5h4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

export function subtaskBadge(p: SubtaskProgressRef | null | undefined): string {
  if (!p || !Number.isFinite(p.total) || p.total <= 0) return '';
  const label = `${p.done} de ${p.total} subtarefas concluídas`;
  const doneCls = p.done >= p.total ? ' task-subs-complete' : '';
  return `<span class="task-subs${doneCls}" title="${escBadge(label)}" aria-label="${escBadge(label)}">${CHECKLIST_ICON}<span class="task-subs-n">${p.done}/${p.total}</span></span>`;
}

const LINK_ICON =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0;vertical-align:-1px">' +
  '<path d="M6.5 9.5 9.5 6.5M6.8 4.2 8 3a2.5 2.5 0 0 1 3.5 3.5L10 8M9.2 11.8 8 13a2.5 2.5 0 0 1-3.5-3.5L6 8" ' +
  'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Ícone discreto de link público ativo — só renderiza quando há uma validade
// (shared=true). expiresBrt no formato curto "DD/MM" (formatBrtShort).
export function shareIconHtml(expiresBrt: string | null): string {
  if (!expiresBrt) return '';
  const label = `Link público ativo até ${expiresBrt}`;
  return `<span class="task-share-icon" title="${escBadge(label)}" aria-label="${escBadge(label)}">${LINK_ICON}</span>`;
}

// ─────────── Fallback de avatar 404 (auditoria UI 2026-07, item P2) ───────────
// Troca a <img> de assignee-dot pela bolinha de iniciais+cor quando a foto não
// carrega (404/blob apagado). Delegado (1 listener pra página inteira) porque o
// evento 'error' de <img> NÃO faz bubble — só é observável via captura (3º
// argumento `true`) num ancestral. Isso também cobre de graça os dots
// RECONSTRUÍDOS pelo client depois do boot (task-edit.ts reatribui
// dotsEl.outerHTML com o mesmo assigneeDotsHtml — replaceWith troca só o nó, o
// listener no document continua valendo pro nó novo).
//
// Tipado como `any`/via `globalThis` de propósito: este arquivo é compilado
// pelo tsconfig RAIZ (sem lib DOM — é importado server-side por
// src/web/notes.ts e src/web/tasks.ts pro SSR, sob @cloudflare/workers-types)
// E pelo tsconfig do client (com DOM), então não dá pra referenciar
// `HTMLImageElement`/`document`/`Event` do DOM como tipo — o compilador raiz
// não os conhece (viraria erro de build). Duck-typing (tagName/dataset) evita
// os nomes de tipo; o guard `!doc` no boot faz o no-op limpo no Workers.
function onAssigneeAvatarError(e: any): void {
  const img = e && e.target;
  if (!img || img.tagName !== 'IMG' || !img.classList) return;
  // Qualquer avatar marcado com data-hue+data-initials entra no fallback (dots
  // do helper, opção do picker, createdby); data-fallback-class permite ao
  // caller ditar a classe do span quando não é um assignee-dot.
  if (img.dataset.hue === undefined || img.dataset.initials === undefined) return;
  const doc = img.ownerDocument;
  const span = doc.createElement('span');
  span.className = img.dataset.fallbackClass || `${img.className} assignee-dot-initials`;
  span.style.background = `hsl(${img.dataset.hue},42%,36%)`;
  span.title = img.title;
  span.setAttribute('aria-label', img.getAttribute('alt') || img.title);
  span.textContent = img.dataset.initials || '?';
  img.replaceWith(span);
}

// Auto-registra quando o módulo carrega NO BROWSER. Guard via globalThis (não
// `typeof document`, que também esbarra na ausência do tipo no tsconfig raiz)
// — no Workers (SSR) `globalThis.document` simplesmente não existe, no-op
// limpo. Guard de "já registrado" TAMBÉM em globalThis (não módulo-local)
// porque tasks.bundle.js e task-edit.bundle.js são bundles esbuild SEPARADOS
// (cada um com sua própria cópia deste módulo) — sem isso, uma página que
// carregasse os dois registraria o listener 2x.
function wireAssigneeAvatarFallback(): void {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || typeof doc.addEventListener !== 'function') return;
  if (g.__ebAssigneeAvatarFallbackWired) return;
  g.__ebAssigneeAvatarFallbackWired = true;
  doc.addEventListener('error', onAssigneeAvatarError, true);
}
wireAssigneeAvatarFallback();
