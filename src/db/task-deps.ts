// Dependências entre tasks (blocked_by), spec 80-frota-agentes/93, migration 0030.
//
// Camada de dados da tabela filha `task_deps`. Segue o contrato dos sub-recursos de
// task (task_subtasks/mentions):
// - NÃO é nota: nada aqui embeda, entra no grafo ou no recall.
// - Reads filtram a task viva nas DUAS pontas (JOIN notes deleted_at IS NULL) —
//   soft-delete não cascateia, então uma bloqueadora apagada some da leitura mas a
//   linha em task_deps sobrevive (restore_note devolve a dependência intacta).
// `task_id` é a task BLOQUEADA; `depends_on_id` é a bloqueadora ("blocked_by" no
// output das tools). Quem valida que as duas tasks existem/são visíveis pra
// credencial é o CALLER (a tool), mesma divisão de responsabilidade dos comments.

import type { Env } from '../env.js';
import { newId } from '../util/id.js';

export interface BlockedTaskRef {
  id: string;
  title: string;
  status: string | null;
}

export type AddDepResult = { ok: true } | { ok: false; error: 'self' | 'cycle' };

// Cria (ou confirma, se já existir) a dependência "task depende de dependsOn".
// Rejeita auto-referência e ciclo DIRETO (dependsOn já depende de task) ANTES de
// escrever — nenhuma das duas checagens toca o banco em caso de rejeição.
export async function addTaskDep(
  env: Env, taskId: string, dependsOnId: string, actor: string | null, now: number
): Promise<AddDepResult> {
  if (taskId === dependsOnId) return { ok: false, error: 'self' };
  const inverse = await env.DB.prepare(
    `SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on_id = ?`
  ).bind(dependsOnId, taskId).first();
  if (inverse) return { ok: false, error: 'cycle' };

  await env.DB.prepare(
    `INSERT INTO task_deps (id, task_id, depends_on_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (task_id, depends_on_id) DO NOTHING`
  ).bind(`dep_${newId()}`, taskId, dependsOnId, now, actor).run();
  return { ok: true };
}

// Remove o par; devolve false se o par não existia (nada pra logar como removido).
export async function removeTaskDep(env: Env, taskId: string, dependsOnId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?`
  ).bind(taskId, dependsOnId).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Quem bloqueia `taskId` (TODAS as dependências declaradas, vivas) — "blocked_by".
export async function listBlockedBy(env: Env, taskId: string): Promise<BlockedTaskRef[]> {
  const r = await env.DB.prepare(
    `SELECT n.id, n.title, n.status
     FROM task_deps d
     JOIN notes n ON n.id = d.depends_on_id AND n.deleted_at IS NULL AND n.kind = 'task'
     WHERE d.task_id = ?
     ORDER BY d.created_at ASC`
  ).bind(taskId).all<BlockedTaskRef>();
  return r.results ?? [];
}

// Quem `taskId` bloqueia (o inverso) — "blocks".
export async function listBlocks(env: Env, taskId: string): Promise<BlockedTaskRef[]> {
  const r = await env.DB.prepare(
    `SELECT n.id, n.title, n.status
     FROM task_deps d
     JOIN notes n ON n.id = d.task_id AND n.deleted_at IS NULL AND n.kind = 'task'
     WHERE d.depends_on_id = ?
     ORDER BY d.created_at ASC`
  ).bind(taskId).all<BlockedTaskRef>();
  return r.results ?? [];
}

const OPEN_STATUSES = new Set(['open', 'in_progress', null]);

// Batch: taskIds → true se QUALQUER bloqueadora VIVA ainda não está done/canceled.
// Ausente do Map = sem dependência pendente (não bloqueada) — mesmo contrato de
// countTaskSubtasksBatch (ausente = sem checklist). Usado pelo filtro `available`
// de list_tasks e pelo campo `blocked` de get_task/list_tasks.
export async function isBlockedBatch(env: Env, taskIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (taskIds.length === 0) return out;
  for (let i = 0; i < taskIds.length; i += 100) {
    const chunk = taskIds.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT d.task_id AS task_id, n.status AS status
       FROM task_deps d
       JOIN notes n ON n.id = d.depends_on_id AND n.deleted_at IS NULL AND n.kind = 'task'
       WHERE d.task_id IN (${ph})`
    ).bind(...chunk).all<{ task_id: string; status: string | null }>();
    for (const row of r.results ?? []) {
      const pending = OPEN_STATUSES.has(row.status);
      if (pending) out.set(row.task_id, true);
      else if (!out.has(row.task_id)) out.set(row.task_id, false);
    }
  }
  return out;
}
