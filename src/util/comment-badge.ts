// Badge de contagem de comentários no card do board (spec 53). Compartilhado entre
// o SSR (src/web/tasks.ts) e o client (src/web/client/tasks.ts) pra render idêntico,
// mesmo padrão do flagSvg de prioridade. Ícone inline (sem emoji, sem dependência).
// n<=0 → string vazia (não polui o card sem comentários).

const COMMENT_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0;vertical-align:-1px">' +
  '<path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2.5V11.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

export function commentBadge(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const label = `${n} comentário${n === 1 ? '' : 's'}`;
  return `<span class="task-comments" title="${label}" aria-label="${label}">${COMMENT_ICON}<span class="task-comments-n">${n}</span></span>`;
}
