// Render compartilhado da thread de comentários (spec 53). Usado pela página pública
// /s/<token> (SSR puro) E pelo detalhe de task no console — mesmo escape, mesmas
// classes CSS (.cmt-*), cada página define o estilo. Comentário é SEMPRE texto puro:
// esc() primeiro (neutraliza HTML/<script>), depois \n → <br> (preserva quebras sem
// reabrir XSS). NUNCA passa por markdown — elimina a classe inteira de injeção.
//
// Assinatura por credencial (spec 80-frota-agentes/81): comentário com author_user
// resolvido exibe o NOME do usuário (a identidade vem da credencial no servidor);
// author_name vira rótulo complementar. Comentário de AGENTE sem assinatura ganha o
// selo "não assinado (legado)" — é o caso em que a autoria era autodeclarada e não
// deve ser tratada como confiável. Dono/convidado legados renderizam como sempre.

import { esc } from '../util/html.js';
import { formatBrtDateTime } from '../util/time.js';
import type { TaskCommentView } from '../db/queries.js';

// Rótulo do autor (texto cru — o caller escapa ao renderizar). Assinado mostra o nome
// do usuário resolvido (+ author_name como sufixo complementar quando presente);
// convidado mostra o nome; agente legado mostra "agente · <nome>" (ou só "agente");
// dono legado mostra "dono".
export function commentAuthorLabel(c: TaskCommentView): string {
  if (c.author_user) {
    return c.author_name && c.author_name !== c.author_user.name
      ? `${c.author_user.name} · ${c.author_name}`
      : c.author_user.name;
  }
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
  // Console: avatar do assinante ao lado do nome (mesmo padrão visual dos assignees).
  // A página pública NÃO passa — /app/users/<id>/avatar exige sessão do dono (o <img>
  // quebraria pra convidado); lá a assinatura aparece só como nome.
  withAvatars?: boolean;
}

// Avatar do assinante (só console, ver RenderThreadOpts.withAvatars). Mesmo fallback
// de iniciais dos assignees do card: hue determinístico pelo id.
function avatarHtml(user: { id: string; name: string; avatar: boolean }): string {
  const initials = user.name.trim().split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase();
  let hash = 0;
  for (const ch of user.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const h = hash % 360;
  if (user.avatar) {
    return `<img class="cmt-avatar" src="/app/users/${esc(user.id)}/avatar" alt="" data-hue="${h}" data-initials="${esc(initials)}" data-fallback-class="cmt-avatar">`;
  }
  return `<span class="cmt-avatar" style="background:hsl(${h},42%,36%)">${esc(initials)}</span>`;
}

// Renderiza a lista de comentários (<ul>). Cada item: cabeçalho (autor + data BRT)
// + corpo escapado. O botão de apagar (console) é um form próprio por item.
export function renderCommentThread(comments: TaskCommentView[], opts: RenderThreadOpts = {}): string {
  if (comments.length === 0) {
    return `<p class="cmt-empty">${esc(opts.emptyLabel ?? 'Ainda não há comentários.')}</p>`;
  }
  const items = comments.map((c) => {
    const label = commentAuthorLabel(c);
    const avatar = opts.withAvatars && c.author_user ? avatarHtml(c.author_user) : '';
    // Selo só no comentário de AGENTE sem assinatura: autoria autodeclarada da era
    // pré-0020. Convidado tem selo próprio no contexto público; dono é sessão do dono.
    const unsigned = c.author === 'agent' && !c.author_user
      ? `<span class="cmt-unsigned" title="Comentário anterior à assinatura por credencial">não assinado (legado)</span>`
      : '';
    const del = opts.deleteTaskId
      ? `<form class="cmt-del-form" method="post" action="/app/tasks/comment/delete">
           <input type="hidden" name="id" value="${esc(c.id)}" />
           <input type="hidden" name="task_id" value="${esc(opts.deleteTaskId)}" />
           <button type="submit" class="cmt-del" title="Apagar comentário" aria-label="Apagar comentário">apagar</button>
         </form>`
      : '';
    return `<li class="cmt-item">
      <div class="cmt-head">
        ${avatar}<span class="cmt-author cmt-author-${esc(c.author)}">${esc(label)}</span>
        ${unsigned}
        <time class="cmt-time">${esc(formatBrtDateTime(c.created_at))}</time>
        ${del}
      </div>
      <div class="cmt-body">${escMultiline(c.body)}</div>
    </li>`;
  }).join('');
  return `<ul class="cmt-thread">${items}</ul>`;
}
