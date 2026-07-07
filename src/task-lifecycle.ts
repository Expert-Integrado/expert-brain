import type { Env } from './env.js';
import { defaultColumnForCategory } from './db/queries.js';

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
