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
function dotHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

// Iniciais: 1ª letra dos dois primeiros nomes ("Ana Almeida" → "AA"; "openclaw" → "O").
function dotInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const second = parts.length > 1 ? parts[1][0] ?? '' : '';
  return (first + second).toUpperCase();
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
        return `<img class="assignee-dot${agentCls}" src="/app/users/${escBadge(a.id)}/avatar" alt="${escBadge(title)}" title="${escBadge(title)}" loading="lazy">`;
      }
      return `<span class="assignee-dot assignee-dot-initials${agentCls}" style="background:hsl(${dotHue(a.id)},42%,36%)" title="${escBadge(title)}" aria-label="${escBadge(title)}">${escBadge(dotInitials(a.name))}</span>`;
    })
    .join('');
  const more = extra > 0 ? `<span class="assignee-dot assignee-dot-initials assignee-dot-more" title="+${extra} responsáveis">+${extra}</span>` : '';
  return `<span class="task-assignees" aria-label="Responsáveis">${dots}${more}</span>`;
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
