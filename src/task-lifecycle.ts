import type { Env } from './env.js';
import { defaultColumnForCategory, addTaskComment } from './db/queries.js';
import { newId } from './util/id.js';

// Auto-cancel de tasks mortas (spec 30-features/32 §4) — DESLIGADO por default.
// Só age quando TASK_AUTOCANCEL_AFTER_DAYS está setada com número > 0 (o repo é
// open-source; nenhum aluno ganha escrita automática sem opt-in explícito).
// Dupla condição: task open VENCIDA há mais de N dias E sem update há mais de N
// dias — task tocada recentemente nunca é cancelada. É um update de status,
// reversível por task via update_task { status: 'open' }; NUNCA deleta.
export async function runTaskAutocancel(
  env: Env,
  now: number
): Promise<{ canceled: number; reason?: string }> {
  const days = parseInt(env.TASK_AUTOCANCEL_AFTER_DAYS ?? '', 10);
  if (!Number.isFinite(days) || days <= 0) {
    return { canceled: 0, reason: 'desligado (TASK_AUTOCANCEL_AFTER_DAYS ausente)' };
  }
  const cutoff = now - days * 86_400_000;
  // Mantém o invariante do Kanban (spec 51): status novo realoca pra coluna
  // default da categoria 'canceled', como setTaskStatus faz.
  const col = await defaultColumnForCategory(env, 'canceled');
  const note = `\n\n**Auto-cancelada:** vencida há mais de ${days} dias sem atividade (reversível via update_task).`;
  // RETURNING id em vez de meta.changes: os triggers de FTS em `notes` inflam o
  // contador do D1 (changes reporta escritas de trigger junto), então a contagem
  // confiável é o número de linhas devolvidas.
  const r = await env.DB.prepare(
    `UPDATE notes SET
       status = 'canceled',
       column_id = ?,
       completed_at = ?,
       updated_at = ?,
       body = COALESCE(body, '') || ?
     WHERE kind = 'task' AND deleted_at IS NULL AND status = 'open'
       AND due_at IS NOT NULL AND due_at < ? AND updated_at < ?
     RETURNING id`
  ).bind(col?.id ?? null, now, now, note, cutoff, cutoff).all<{ id: string }>();
  return { canceled: r.results?.length ?? 0 };
}

// Aging automático de task parada (spec 80-frota-agentes/94) — DESLIGADO por
// default. Só age quando TASK_AGING_AFTER_DAYS está setada com número > 0 (mesmo
// opt-in do autocancel acima: o repo é open-source, ninguém ganha mutação
// automática sem configurar). Task in_progress SEM NENHUM update (comentário ou
// edição — updated_at cobre os dois, addTaskComment não toca updated_at mas o
// caller de comment_task/complete_task/update_task sim) há mais de N dias volta
// pra 'open' e SOLTA o claim (o lease em si já expira sozinho por construção,
// mas uma task esquecida com claim ainda "válido" continua fora da fila
// available:true — reabrir sem soltar deixaria o cap contando trabalho morto).
// Nunca cancela, nunca apaga — só devolve pra fila com rastro: comentário [info]
// automático no thread (author 'agent', sem author_user_id — escrita de sistema,
// sem credencial por trás) + nota no body, mesmo padrão do autocancel.
export async function runTaskAging(
  env: Env,
  now: number
): Promise<{ reopened: number; reason?: string }> {
  const days = parseInt(env.TASK_AGING_AFTER_DAYS ?? '', 10);
  if (!Number.isFinite(days) || days <= 0) {
    return { reopened: 0, reason: 'desligado (TASK_AGING_AFTER_DAYS ausente)' };
  }
  const cutoff = now - days * 86_400_000;
  const col = await defaultColumnForCategory(env, 'open');
  const note = `\n\n**Reaberta automaticamente:** sem atividade há mais de ${days} dias em 'in_progress' (aging da frota).`;
  const infoBody = `[info] Task reaberta automaticamente: sem nenhum update ha mais de ${days} dias em 'in_progress'. Claim liberado. Se ainda estiver em andamento, comente ou edite pra sinalizar atividade.`;
  // RETURNING id/title em vez de meta.changes (mesmo motivo do autocancel: os
  // triggers de FTS em `notes` inflam o contador do D1) — e aqui também precisamos
  // do id de cada task pra gravar o comentário [info] individualmente.
  const r = await env.DB.prepare(
    `UPDATE notes SET
       status = 'open',
       column_id = ?,
       claimed_by = NULL,
       claimed_at = NULL,
       claim_expires_at = NULL,
       updated_at = ?,
       body = COALESCE(body, '') || ?
     WHERE kind = 'task' AND deleted_at IS NULL AND status = 'in_progress'
       AND updated_at < ?
     RETURNING id`
  ).bind(col?.id ?? null, now, note, cutoff).all<{ id: string }>();
  const ids = r.results?.map((row) => row.id) ?? [];
  for (const id of ids) {
    try {
      await addTaskComment(env, {
        id: `cmt_${newId()}`,
        task_id: id,
        author: 'agent',
        author_name: 'cron:aging',
        body: infoBody,
        created_at: now,
        author_user_id: null,
        author_key_id: null,
        kind: 'info',
      });
    } catch (e) {
      // Best-effort: a task JÁ foi reaberta (o UPDATE acima já commitou) — falha
      // ao comentar não deve contar como falha do job inteiro nem reverter o reopen.
      console.error(`task-aging: falha ao comentar [info] em ${id}`, e);
    }
  }
  return { reopened: ids.length };
}
