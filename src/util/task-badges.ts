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

// Chip de PROJETO no card (spec 58): bolinha na cor do projeto + label. Projeto
// arquivado renderiza esmaecido (classe .archived). null → string vazia (task sem
// projeto não polui o card). Cor só entra no style se for hex #rrggbb válido.
export function projectChipHtml(
  project: { label: string; color: string | null; archived?: boolean } | null
): string {
  if (!project) return '';
  const dot = project.color && /^#[0-9a-fA-F]{6}$/.test(project.color)
    ? ` style="background:${project.color}"`
    : '';
  const cls = project.archived ? 'task-project-chip archived' : 'task-project-chip';
  const label = escBadge(project.label);
  return `<span class="${cls}" title="Projeto: ${label}"><span class="task-project-dot"${dot}></span>${label}</span>`;
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
