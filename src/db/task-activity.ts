import type { Env } from '../env.js';
import { formatBrtDateTime } from '../util/time.js';

// Log de atividade de task (spec 74, migration 0019) — histórico ANTES/DEPOIS por
// campo, exibido no detalhe da task. Tabela própria (não é nota): não embeda, não
// entra no grafo/recall/FTS. Ver o comentário da migration em db/migrate.ts pro
// racional completo (cascade, autoria, por que `field` não é CHECK).

// Enum fechado em CÓDIGO (a coluna é TEXT livre — ver migrate.ts). Mantido em
// sincronia com os campos realmente logados por queries.ts e pelos handlers web.
export type TaskActivityField =
  | 'created' | 'title' | 'body' | 'column' | 'priority' | 'due'
  | 'tags' | 'project' | 'assignees' | 'visibility' | 'share' | 'status';

export interface TaskActivityEntry {
  id: number;
  task_id: string;
  at: number;
  actor: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
}

export interface TaskActivityInput {
  field: TaskActivityField;
  old_value?: string | null;
  new_value?: string | null;
}

// Grava N entradas numa escrita só (mesmo `at`, uma linha por campo mudado).
// BEST-EFFORT DE PROPÓSITO: o log é auditoria, não fonte de verdade — a escrita real
// da task (UPDATE em notes) já foi commitada ANTES deste call, então uma falha aqui
// (D1 momentaneamente instável, ou uma instância que ainda não rodou a migration 0019)
// NUNCA pode derrubar a edição. Erro é engolido e só reportado no console, mesmo
// padrão do aviso de duplicata em save_task (findSimilarActiveTasksByTitle).
export async function logTaskActivity(
  env: Env,
  taskId: string,
  actor: string | null | undefined,
  entries: TaskActivityInput[]
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const at = Date.now();
    const stmt = env.DB.prepare(
      `INSERT INTO task_activity (task_id, at, actor, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)`
    );
    await env.DB.batch(
      entries.map((e) =>
        stmt.bind(taskId, at, actor ?? null, e.field, e.old_value ?? null, e.new_value ?? null)
      )
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`logTaskActivity failed for task ${taskId}:`, msg);
  }
}

// Mais recente primeiro. `id DESC` como desempate de `at` (mesmo ms em gravações
// em lote) — o índice idx_task_activity_task(task_id, at DESC) cobre a query.
export async function listTaskActivity(env: Env, taskId: string, limit = 50): Promise<TaskActivityEntry[]> {
  const r = await env.DB.prepare(
    `SELECT id, task_id, at, actor, field, old_value, new_value FROM task_activity
     WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?`
  ).bind(taskId, limit).all<TaskActivityEntry>();
  return r.results ?? [];
}

// ─────────────── Formatters (strings curtas e legíveis pro log) ───────────────
// Compartilhados por queries.ts (insertTask/updateTask/completeTask/moveTaskToColumn/
// setTaskPrivate) pra montar old_value/new_value sem duplicar regra de formatação em
// cada função de escrita. `priorityLabel` (util/priority.ts) já cobre prioridade —
// não duplicado aqui.

export function truncateForActivity(s: string, max = 80): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function dueLabelForActivity(ms: number | null): string {
  return ms !== null ? formatBrtDateTime(ms) : 'sem prazo';
}

// Espelha os rótulos do board (STATUS_LABELS em share.ts/config.ts/notes.ts) — cópia
// local de propósito: db/ não importa de web/ (evita inversão de camada).
const STATUS_LABELS_ACTIVITY: Record<string, string> = {
  open: 'A fazer',
  in_progress: 'Em progresso',
  done: 'Concluído',
  canceled: 'Cancelado',
};

export function statusLabelForActivity(status: string | null): string {
  return status ? (STATUS_LABELS_ACTIVITY[status] ?? status) : STATUS_LABELS_ACTIVITY.open;
}

// Lista de tags legível pro diff — ignora as reservadas dedupe:* (nunca aparecem em
// nenhuma superfície de UI, ver replaceTaskTagsPreservingDedupe) e ordena pra não
// logar "mudança" quando só a ORDEM das tags mudou.
export function formatTagListForActivity(tags: string[]): string {
  const visible = [...new Set(tags.filter((t) => !t.startsWith('dedupe:')))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return visible.length > 0 ? visible.join(', ') : '(sem tags)';
}
