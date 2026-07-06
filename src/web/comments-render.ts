// Render compartilhado da thread de comentários (spec 53). Usado pela página pública
// /s/<token> (SSR puro) E pelo detalhe de task no console — mesmo escape, mesmas
// classes CSS (.cmt-*), cada página define o estilo. Comentário é SEMPRE texto puro:
// esc() primeiro (neutraliza HTML/<script>), depois \n → <br> (preserva quebras sem
// reabrir XSS). NUNCA passa por markdown — elimina a classe inteira de injeção.

import { esc } from '../util/html.js';
import { formatBrtDateTime } from '../util/time.js';
import type { TaskComment } from '../db/queries.js';

// Rótulo do autor (texto cru — o caller escapa ao renderizar). Convidado mostra o
// nome; agente mostra "agente · <nome>" (ou só "agente"); dono mostra "dono".
export function commentAuthorLabel(c: TaskComment): string {
  if (c.author === 'owner') return 'dono';
  if (c.author === 'agent') return c.author_name ? `agente · ${c.author_name}` : 'agente';
  return c.author_name || 'convidado';
}

// Escapa E preserva quebras de linha. esc() ANTES do \n→<br>: o <br> injetado é o
// único HTML de saída; qualquer '<'/'>' do texto já virou entidade inerte.
export function escMultiline(s: string): string {
  return esc(s).replace(/\r\n|\r|\n/g, '<br>');
}

export interface RenderThreadOpts {
  // Quando setado, mostra um botão de apagar por comentário (só o console do dono
  // passa). O taskId vai no form pra o redirect voltar ao detalhe certo.
  deleteTaskId?: string;
  emptyLabel?: string;
}

// Renderiza a lista de comentários (<ul>). Cada item: cabeçalho (autor + data BRT)
// + corpo escapado. O botão de apagar (console) é um form próprio por item.
export function renderCommentThread(comments: TaskComment[], opts: RenderThreadOpts = {}): string {
  if (comments.length === 0) {
    return `<p class="cmt-empty">${esc(opts.emptyLabel ?? 'Ainda não há comentários.')}</p>`;
  }
  const items = comments.map((c) => {
    const label = commentAuthorLabel(c);
    const del = opts.deleteTaskId
      ? `<form class="cmt-del-form" method="post" action="/app/tasks/comment/delete">
           <input type="hidden" name="id" value="${esc(c.id)}" />
           <input type="hidden" name="task_id" value="${esc(opts.deleteTaskId)}" />
           <button type="submit" class="cmt-del" title="Apagar comentário" aria-label="Apagar comentário">apagar</button>
         </form>`
      : '';
    return `<li class="cmt-item">
      <div class="cmt-head">
        <span class="cmt-author cmt-author-${esc(c.author)}">${esc(label)}</span>
        <time class="cmt-time">${esc(formatBrtDateTime(c.created_at))}</time>
        ${del}
      </div>
      <div class="cmt-body">${escMultiline(c.body)}</div>
    </li>`;
  }).join('');
  return `<ul class="cmt-thread">${items}</ul>`;
}
