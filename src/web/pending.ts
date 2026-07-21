import type { Env } from '../env.js';
import { listKanbanColumns, listAwaitingOwnerBanner, type KanbanColumn } from '../db/queries.js';
import { listValidationTasks, type ValidationTask } from '../db/fleet-queries.js';
import type { PendingItem } from '../util/task-badges.js';
import { formatBrtShort } from '../util/time.js';

// "Pendências com você" (rodada 6, 20/07 — extraído do buildBoard de
// src/web/tasks.ts): montagem das DUAS filas que esperam o dono — PERGUNTAS de
// agentes (bloqueio sem resposta, spec 88/89) e ENTREGAS pra aprovar (coluna
// "Validação humana", spec 92). Vive num módulo próprio porque agora o consomem
// DUAS superfícies (board /app/tasks e card da home /app) — home.ts importar
// tasks.ts criaria ciclo. Este módulo só importa src/db/* e utils folha
// (task-badges/time) — nunca outro src/web/* (anti-ciclo por construção).

// Coluna de validação achada por LABEL (não é seed — o dono a criou no board),
// fragilidade herdada da spec 92; a definição MUDOU de src/web/fleet.ts pra cá
// (fleet.ts re-importa daqui) pra manter o contrato de imports acima.
export const VALIDATION_COLUMN_LABEL = 'validação humana';

export function findValidationColumn(cols: KanbanColumn[]): KanbanColumn | null {
  return cols.find((c) => c.label.trim().toLowerCase() === VALIDATION_COLUMN_LABEL) ?? null;
}

// Junta as duas filas e ordena por urgência — quem espera há mais tempo primeiro;
// prioridade (1=Crítica) desempata, sem prioridade por último. Task que está nas
// DUAS filas (entrega parada COM pergunta aberta) aparece uma vez só, como
// pergunta — é ela que trava tudo. Cada fila é best-effort (falha vira fila
// vazia, com log): o board/home nunca quebram por causa disto.
// `activeCols` opcional: o buildBoard já tem as colunas ativas carregadas —
// passa pra economizar 1 query; a home chama sem e este módulo busca sozinho.
export async function buildPendingItems(env: Env, activeCols?: KanbanColumn[]): Promise<PendingItem[]> {
  const [cols, awaiting] = await Promise.all([
    activeCols ? Promise.resolve(activeCols) : listKanbanColumns(env, false),
    // Perguntas aguardando o dono (spec 89): best-effort.
    listAwaitingOwnerBanner(env).catch((err) => {
      console.error('awaiting-owner: fila de perguntas falhou (best-effort):', err instanceof Error ? err.message : err);
      return [];
    }),
  ]);
  // Entregas na coluna "Validação humana" — segunda fila. Best-effort, como a de
  // perguntas.
  const validationCol = findValidationColumn(cols);
  const validation: ValidationTask[] = validationCol
    ? await listValidationTasks(env, validationCol.id).catch((err) => {
        console.error('pendencias: fila de validação falhou (best-effort):', err instanceof Error ? err.message : err);
        return [];
      })
    : [];

  const questionIds = new Set(awaiting.map((a) => a.id));
  const pendingSortable = [
    ...awaiting.map((a) => ({
      item: {
        kind: 'question' as const,
        id: a.id,
        title: a.title,
        body: a.block_body,
        author: a.block_author,
        since_brt: formatBrtShort(a.block_at),
      },
      since: a.block_at,
      prio: a.priority ?? Number.MAX_SAFE_INTEGER,
    })),
    ...validation
      .filter((v) => !questionIds.has(v.id))
      .map((v) => ({
        item: {
          kind: 'approval' as const,
          id: v.id,
          title: v.title,
          // O que está sendo entregue (Eric, 21/07): o corpo do último
          // comentário [entrega] — mesmo papel do [bloqueio] na pergunta.
          // Sem comentário, cai no tldr (quando não repete o título).
          body: v.deliveredBody || (v.tldr && v.tldr !== v.title ? v.tldr : ''),
          author: v.deliveredBy,
          since_brt: formatBrtShort(v.updatedAt),
        },
        since: v.updatedAt,
        prio: v.priority ?? Number.MAX_SAFE_INTEGER,
      })),
  ].sort((x, y) => x.since - y.since || x.prio - y.prio);
  return pendingSortable.map((p) => p.item);
}

// Sumário do bloco pra cabeçalhos/summary ("N", "X perguntas", "Y para aprovar")
// — compartilhado entre o <summary> do board e o h2 do card da home, pra os dois
// nunca divergirem do que o pendingBlockHtml conta por dentro.
export function pendingKindsLabel(items: PendingItem[]): string {
  const q = items.filter((i) => i.kind === 'question').length;
  const a = items.length - q;
  const kinds: string[] = [];
  if (q > 0) kinds.push(`${q} pergunta${q === 1 ? '' : 's'}`);
  if (a > 0) kinds.push(`${a} para aprovar`);
  return kinds.join(', ');
}

// CSS do bloco de pendências — morava no TASKS_CSS; extraído na rodada 6 porque
// o card da home renderiza o MESMO markup (pendingBlockHtml) e precisava dos
// mesmos estilos (a fleet já tinha sofrido com o banner sem CSS — não repetir).
// Só tokens de tema — funciona no claro e no escuro. Este CSS viaja inteiro pro
// <head> das páginas, então nada de citar o nome do banner antigo aqui.
export const PENDING_CSS = `
/* Bloco "Pendências com você" (19/07, substitui o banner antigo da spec 89):
   perguntas de agentes + entregas pra aprovar. Some inteiro quando vazio
   ([hidden]). */
.task-pending {
  background: rgba(251,191,36,0.06); border: 1px solid rgba(251,191,36,0.35);
  border-radius: var(--radius); padding: 12px 14px; margin-bottom: 20px;
}
.task-pending[hidden] { display: none; }
.task-pending-head {
  font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--warning); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.task-pending-count {
  font-size: 11px; background: rgba(251,191,36,0.15); border-radius: 999px;
  padding: 1px 8px; font-variant-numeric: tabular-nums;
}
.task-pending-kinds { font-size: 11px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--text-dim); margin-left: auto; }
.task-pending-list { display: flex; flex-direction: column; gap: 4px; }
.task-pending-item {
  position: relative; display: flex; flex-direction: column; gap: 3px;
  padding: 8px; border-radius: var(--radius-sm); transition: background 140ms var(--ease);
}
.task-pending-item:hover { background: rgba(251,191,36,0.08); }
/* Duas linhas (Eric, 21/07 — sem etiquetas de tipo): título + ações na de cima,
   descrição + meta na de baixo. Ações e meta empilham no canto direito. */
.task-pending-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.task-pending-title { font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; text-decoration: none; }
.task-pending-title:hover { color: var(--accent-lav); }
.task-pending-sub { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.task-pending-meta { font-size: 11px; color: var(--text-subtle); white-space: nowrap; flex: none; margin-left: auto; }
.task-pending-body { font-size: 12px; color: var(--text-dim); line-height: 1.45; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; flex: 1 1 auto; min-width: 0; }
/* Ações no canto direito da primeira linha — em cima da meta. */
.task-pending-actions { display: flex; gap: 8px; align-items: center; flex: none; margin-left: auto; }
.task-pending-quick { display: inline-flex; gap: 6px; margin: 0; }
/* "Responder" (texto livre): checkbox oculto controla o form de largura total
   abaixo do item — CSS puro, funciona sem JS (mesma garantia do <details> que
   ele substitui). O input fica focável pro teclado (não usa display:none). */
.task-pending-toggle { position: absolute; width: 1px; height: 1px; opacity: 0; margin: 0; pointer-events: none; }
.task-pending-reply-toggle {
  cursor: pointer; font-size: 12px; color: var(--accent-lav); white-space: nowrap; padding: 2px 0;
}
.task-pending-reply-toggle:hover { color: var(--text); }
.task-pending-toggle:focus-visible ~ .task-pending-row .task-pending-reply-toggle { outline: 2px solid var(--accent-lav); outline-offset: 2px; border-radius: 3px; }
.task-pending-reply-form { display: none; flex-direction: column; gap: 6px; margin-top: 4px; }
.task-pending-toggle:checked ~ .task-pending-reply-form { display: flex; }
.task-pending-reply-form textarea {
  width: 100%; resize: vertical; min-height: 48px;
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; font-family: inherit;
}
.task-pending-reply-form textarea:focus { outline: none; border-color: var(--accent-lav); }
.task-pending-reply-form .btn { align-self: flex-start; }
/* "Ver mais (N)": o resto da fila expande inline, sem navegar. */
.task-pending-more { margin-top: 4px; }
.task-pending-more > summary {
  list-style: none; cursor: pointer; font-size: 12px; color: var(--text-dim);
  width: fit-content; padding: 4px 8px; border-radius: var(--radius-sm);
  transition: color 140ms var(--ease), background 140ms var(--ease);
}
.task-pending-more > summary::-webkit-details-marker { display: none; }
.task-pending-more > summary:hover { color: var(--text); background: rgba(251,191,36,0.08); }
.task-pending-more[open] > summary { margin-bottom: 4px; }
@media (max-width: 767px) {
  /* Estreito: título quebra em linha própria; ações descem pra baixo dele,
     ainda à direita; meta segue no fim. */
  .task-pending-row { flex-wrap: wrap; row-gap: 4px; }
  .task-pending-title { white-space: normal; flex-basis: 100%; }
  .task-pending-sub { flex-wrap: wrap; row-gap: 2px; }
}
`;
