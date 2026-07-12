// Subtarefas (checklist) de uma task — spec 30-features/38.
//
// Camada de dados da tabela filha `task_subtasks` (migration 0029). Segue o
// contrato dos sub-recursos de task (task_comments/task_activity):
// - NÃO é nota: nada aqui embeda, entra no grafo ou no recall.
// - Reads filtram a task viva (JOIN notes deleted_at IS NULL) porque o
//   soft-delete não cascateia — restore_note devolve o checklist intacto.
// - Mutação de subtask NÃO toca notes.updated_at: um tick não pode invalidar o
//   expected_updated_at de uma edição otimista concorrente na task.
// Quem valida que a task existe/é visível pra credencial é o CALLER (tool ou
// handler web via getTaskById) — mesma divisão de responsabilidade dos comments.

import type { Env } from '../env.js';
import { newId } from '../util/id.js';

export interface TaskSubtask {
  id: string;             // 'sub_' + newId()
  task_id: string;
  title: string;
  position: number;       // append-only: max(position)+1 na criação
  done_at: number | null; // NULL = aberta; timestamp = feita (único marcador de estado)
  done_by: string | null; // actor que marcou: 'oauth:<email>' | id de PAT
  created_by: string | null;
  created_at: number;
}

export interface SubtaskProgress {
  done: number;
  total: number;
}

// Cap por task, validado no add (o CHECK do banco cobre só o tamanho do título).
export const MAX_SUBTASKS_PER_TASK = 100;

const COLS = 'id, task_id, title, position, done_at, done_by, created_by, created_at';

// Anexa itens ao fim do checklist (position = max+1 contínuo). Retorna as rows
// criadas em ordem, ou 'cap-exceeded' SEM gravar nada se o lote estourar o cap.
export async function addTaskSubtasks(
  env: Env, taskId: string, titles: string[], actor: string | null, now: number
): Promise<TaskSubtask[] | 'cap-exceeded'> {
  if (titles.length === 0) return [];
  const cur = await env.DB.prepare(
    `SELECT count(*) AS c, COALESCE(max(position), 0) AS maxpos FROM task_subtasks WHERE task_id = ?`
  ).bind(taskId).first<{ c: number; maxpos: number }>();
  const existing = cur?.c ?? 0;
  if (existing + titles.length > MAX_SUBTASKS_PER_TASK) return 'cap-exceeded';

  let pos = cur?.maxpos ?? 0;
  const created: TaskSubtask[] = titles.map((title) => ({
    id: `sub_${newId()}`,
    task_id: taskId,
    title,
    position: ++pos,
    done_at: null,
    done_by: null,
    created_by: actor,
    created_at: now,
  }));
  const stmt = env.DB.prepare(
    `INSERT INTO task_subtasks (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(created.map((s) =>
    stmt.bind(s.id, s.task_id, s.title, s.position, s.done_at, s.done_by, s.created_by, s.created_at)
  ));
  return created;
}

// Lista o checklist de uma task VIVA, na ordem do board (position, id desempata).
export async function listTaskSubtasks(env: Env, taskId: string): Promise<TaskSubtask[]> {
  const r = await env.DB.prepare(
    `SELECT s.${COLS.split(', ').join(', s.')}
     FROM task_subtasks s
     JOIN notes n ON n.id = s.task_id AND n.deleted_at IS NULL AND n.kind = 'task'
     WHERE s.task_id = ?
     ORDER BY s.position ASC, s.id ASC`
  ).bind(taskId).all<TaskSubtask>();
  return r.results ?? [];
}

// Marca/desmarca um item. Idempotente de verdade: se o item já está no estado
// alvo, retorna a row SEM re-stampar done_at/done_by (retry de rede não reescreve
// quem concluiu). O WHERE composto (id + task_id) impede mutação cross-task.
export async function setSubtaskDone(
  env: Env, taskId: string, subId: string, done: boolean, actor: string | null, now: number
): Promise<TaskSubtask | 'not-found'> {
  const row = await env.DB.prepare(
    `SELECT ${COLS} FROM task_subtasks WHERE id = ? AND task_id = ?`
  ).bind(subId, taskId).first<TaskSubtask>();
  if (!row) return 'not-found';
  const isDone = row.done_at !== null;
  if (isDone === done) return row;
  const done_at = done ? now : null;
  const done_by = done ? actor : null;
  await env.DB.prepare(
    `UPDATE task_subtasks SET done_at = ?, done_by = ? WHERE id = ? AND task_id = ?`
  ).bind(done_at, done_by, subId, taskId).run();
  return { ...row, done_at, done_by };
}

export async function retitleSubtask(
  env: Env, taskId: string, subId: string, title: string
): Promise<TaskSubtask | 'not-found'> {
  const res = await env.DB.prepare(
    `UPDATE task_subtasks SET title = ? WHERE id = ? AND task_id = ?`
  ).bind(title, subId, taskId).run();
  if ((res.meta?.changes ?? 0) === 0) return 'not-found';
  const row = await env.DB.prepare(
    `SELECT ${COLS} FROM task_subtasks WHERE id = ?`
  ).bind(subId).first<TaskSubtask>();
  return row ?? 'not-found';
}

// Remove um item e DEVOLVE a row removida — o caller usa o título no log de
// atividade ("subtarefa removida: ...").
export async function deleteSubtask(
  env: Env, taskId: string, subId: string
): Promise<TaskSubtask | 'not-found'> {
  const row = await env.DB.prepare(
    `SELECT ${COLS} FROM task_subtasks WHERE id = ? AND task_id = ?`
  ).bind(subId, taskId).first<TaskSubtask>();
  if (!row) return 'not-found';
  await env.DB.prepare(`DELETE FROM task_subtasks WHERE id = ?`).bind(subId).run();
  return row;
}

// Progresso {done,total} por task numa query só (GROUP BY, chunked pra não
// estourar os binds do D1) — pro payload do board sem N+1. Recebe ids de tasks
// já vivas (o board só carrega não-deletadas), então dispensa o JOIN — mesmo
// contrato de countTaskCommentsBatch. Ausente do Map = task sem checklist.
export async function countTaskSubtasksBatch(
  env: Env, taskIds: string[]
): Promise<Map<string, SubtaskProgress>> {
  const out = new Map<string, SubtaskProgress>();
  if (taskIds.length === 0) return out;
  for (let i = 0; i < taskIds.length; i += 100) {
    const chunk = taskIds.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT task_id, count(*) AS total, count(done_at) AS done FROM task_subtasks
       WHERE task_id IN (${ph})
       GROUP BY task_id`
    ).bind(...chunk).all<{ task_id: string; total: number; done: number }>();
    for (const row of r.results ?? []) out.set(row.task_id, { done: row.done, total: row.total });
  }
  return out;
}

export function subtaskProgress(subs: Pick<TaskSubtask, 'done_at'>[]): SubtaskProgress {
  return { done: subs.filter((s) => s.done_at !== null).length, total: subs.length };
}
