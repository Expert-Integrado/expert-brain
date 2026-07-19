import type { Env } from '../env.js';

// Fleet view (specs/80-frota-agentes/92-fleet-view.md): agregações read-only do
// painel da frota. Nenhuma coleta nova — só leitura de users/api_keys/notes/
// task_activity/task_comments. Janela "hoje" em BRT FIXO (UTC-3), mesma convenção
// de util/time.ts e insights-queries.ts.

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Meia-noite BRT do dia corrente de `nowMs`, em unix ms (03:00 UTC). */
export function startOfTodayBrt(nowMs: number): number {
  const shifted = new Date(nowMs - BRT_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 3, 0, 0);
}

export interface FleetAgent {
  id: string;
  name: string;
  hasAvatar: boolean;
  /** Alguma chave ATIVA (não revogada) aponta pro user — via user_id ou legacy api_key_id. */
  hasKey: boolean;
}

// Todos os usuários tipo agent não arquivados. Agente sem chave vinculada NÃO some
// da lista (critério de aceite) — a flag hasKey vira o estado "sem credencial".
// hasKey olha as DUAS vias de vínculo (api_keys.user_id + legacy users.api_key_id,
// mesma regra do getUserByApiKeyId); lastSeenByUser só agrega via user_id — agente
// só-legacy aparece "sem uso" até migrar (limitação aceita, spec 86 já migrou tudo).
export async function listFleetAgents(env: Env): Promise<FleetAgent[]> {
  const r = await env.DB.prepare(
    `SELECT u.id, u.name,
            (u.avatar_key IS NOT NULL) AS has_avatar,
            (EXISTS (SELECT 1 FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL)
             OR EXISTS (SELECT 1 FROM api_keys k2 WHERE k2.id = u.api_key_id AND k2.revoked_at IS NULL)) AS has_key
     FROM users u
     WHERE u.type = 'agent' AND u.archived_at IS NULL
     ORDER BY u.created_at ASC`
  ).all<{ id: string; name: string; has_avatar: number; has_key: number }>();
  return (r.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    hasAvatar: row.has_avatar === 1,
    hasKey: row.has_key === 1,
  }));
}

export interface AgentDayActivity {
  tasksTouched: number;
  notesAuthored: number;
  comments: number;
}

// Contagens de HOJE (BRT) por usuário, mapeando autoria por credencial de volta
// pro dono da chave (actor/created_by/updated_by = api_keys.id; 'oauth:<email>'
// não tem JOIN e fica de fora — o painel é sobre AGENTES). Tasks e notas vivem
// ambas em `notes` (kind separa): "task tocada" = edição logada em task_activity
// OU task criada hoje (criação não gera activity), deduplicada por id; "nota" é
// só conhecimento (kind != 'task'), e atualizada exclui as criadas hoje pra não
// contar a mesma nota duas vezes.
export async function fleetActivityToday(env: Env, nowMs: number): Promise<Map<string, AgentDayActivity>> {
  const start = startOfTodayBrt(nowMs);
  const [touched, created, updated, comments] = await Promise.all([
    env.DB.prepare(
      `SELECT uid, COUNT(DISTINCT tid) AS c FROM (
         SELECT k.user_id AS uid, a.task_id AS tid
         FROM task_activity a JOIN api_keys k ON k.id = a.actor
         WHERE a.at >= ? AND k.user_id IS NOT NULL
         UNION
         SELECT k.user_id AS uid, n.id AS tid
         FROM notes n JOIN api_keys k ON k.id = n.created_by
         WHERE n.created_at >= ? AND n.kind = 'task' AND n.deleted_at IS NULL AND k.user_id IS NOT NULL
       ) GROUP BY uid`
    ).bind(start, start).all<{ uid: string; c: number }>(),
    env.DB.prepare(
      `SELECT k.user_id AS uid, COUNT(*) AS c
       FROM notes n JOIN api_keys k ON k.id = n.created_by
       WHERE n.created_at >= ? AND n.kind != 'task' AND n.deleted_at IS NULL AND k.user_id IS NOT NULL
       GROUP BY k.user_id`
    ).bind(start).all<{ uid: string; c: number }>(),
    env.DB.prepare(
      `SELECT k.user_id AS uid, COUNT(*) AS c
       FROM notes n JOIN api_keys k ON k.id = n.updated_by
       WHERE n.updated_at >= ? AND n.created_at < ? AND n.kind != 'task' AND n.deleted_at IS NULL AND k.user_id IS NOT NULL
       GROUP BY k.user_id`
    ).bind(start, start).all<{ uid: string; c: number }>(),
    env.DB.prepare(
      `SELECT tc.author_user_id AS uid, COUNT(*) AS c
       FROM task_comments tc
       WHERE tc.created_at >= ? AND tc.author_user_id IS NOT NULL
       GROUP BY tc.author_user_id`
    ).bind(start).all<{ uid: string; c: number }>(),
  ]);

  const map = new Map<string, AgentDayActivity>();
  const bump = (uid: string, patch: Partial<AgentDayActivity>) => {
    const cur = map.get(uid) ?? { tasksTouched: 0, notesAuthored: 0, comments: 0 };
    map.set(uid, { ...cur, ...patch });
  };
  for (const row of touched.results ?? []) bump(row.uid, { tasksTouched: row.c });
  for (const row of created.results ?? []) bump(row.uid, { notesAuthored: row.c });
  for (const row of updated.results ?? []) {
    const cur = map.get(row.uid) ?? { tasksTouched: 0, notesAuthored: 0, comments: 0 };
    map.set(row.uid, { ...cur, notesAuthored: cur.notesAuthored + row.c });
  }
  for (const row of comments.results ?? []) bump(row.uid, { comments: row.c });
  return map;
}

export interface ValidationTask {
  id: string;
  title: string;
  /** Resumo curto da task (tldr) — corpo do item no "Pendências com você". */
  tldr: string;
  updatedAt: number;
  /** Prioridade da task (1-4/null) — desempate de urgência no bloco do board. */
  priority: number | null;
  /** Autor do último comentário [entrega] — quem entregou pro dono validar. */
  deliveredBy: string | null;
  /** Projeto (pasta) da task. */
  projectLabel: string | null;
  projectColor: string | null;
}

// Tasks paradas na coluna de validação (mais antiga primeiro — quem espera há mais
// tempo no topo, mesma regra do banner de bloqueios). Consumido pelo bloco
// "Pendências com você" do board (src/web/tasks.ts) desde 19/07.
export async function listValidationTasks(env: Env, columnId: string): Promise<ValidationTask[]> {
  const r = await env.DB.prepare(
    `SELECT n.id, n.title, n.tldr, n.updated_at, n.priority, p.label AS project_label, p.color AS project_color,
            (SELECT u.name FROM task_comments tc JOIN users u ON u.id = tc.author_user_id
              WHERE tc.task_id = n.id AND tc.kind = 'entrega'
              ORDER BY tc.created_at DESC, tc.id DESC LIMIT 1) AS delivered_by
     FROM notes n
     LEFT JOIN task_projects p ON p.id = n.project_id
     WHERE n.kind = 'task' AND n.column_id = ? AND n.deleted_at IS NULL
     ORDER BY n.updated_at ASC`
  ).bind(columnId).all<{ id: string; title: string; tldr: string; updated_at: number; priority: number | null; project_label: string | null; project_color: string | null; delivered_by: string | null }>();
  return (r.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    tldr: row.tldr,
    updatedAt: row.updated_at,
    priority: row.priority,
    deliveredBy: row.delivered_by,
    projectLabel: row.project_label,
    projectColor: row.project_color,
  }));
}
