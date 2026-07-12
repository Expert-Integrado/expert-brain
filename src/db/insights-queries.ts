import type { Env } from '../env.js';

// Agregados mensais do dashboard "Seu cérebro" (specs/91-experiencia-premium/99).
// Read-only sobre dados que já existem (notes/edges/task_activity) — nenhuma
// coleta nova. Janela mensal em BRT (UTC-3 FIXO, mesma convenção de util/time.ts):
// nota criada dia 1º 00:30 BRT conta no mês novo (critério de aceite).

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// [start, end) em unix ms do mês BRT. Meia-noite BRT do dia 1º = 03:00 UTC.
// month é 1-12; month=13 normaliza pro janeiro seguinte (Date.UTC faz o carry).
export function monthWindowBrt(year: number, month: number): { start: number; end: number } {
  return {
    start: Date.UTC(year, month - 1, 1, 3, 0, 0),
    end: Date.UTC(year, month, 1, 3, 0, 0),
  };
}

// Ano/mês BRT de um instante — pro default "mês corrente" do handler e pra
// navegação anterior/próximo.
export function brtYearMonth(ms: number): { year: number; month: number } {
  const shifted = new Date(ms - BRT_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

export interface MonthInsights {
  year: number;
  month: number;
  /** Notas de conhecimento vivas criadas no mês (kind != 'task'; deletadas fora). */
  captured: number;
  /** Contagem por semana do mês (dias 1-7, 8-14, ... — 4 ou 5 buckets). */
  byWeek: number[];
  byKind: { kind: string; c: number }[];
  /** Top 5 domínios por contagem de notas capturadas. */
  byDomain: { domain: string; c: number }[];
  /** Edges criadas no mês com AMBAS as pontas vivas (mesma semântica do grafo). */
  edgesCreated: number;
  /** Nota com mais edges criadas no mês. private=true → nunca exibir o título. */
  mostConnected: { id: string; title: string; private: boolean; degree: number } | null;
  tasksDone: number;
  /** Dono = updated_by 'oauth:%' OU NULL (console/linha antiga sem autoria). */
  tasksDoneOwner: number;
  /** Agente = updated_by não-nulo que não é 'oauth:%' (id de PAT). */
  tasksDoneAgent: number;
  /** Frota: notas criadas por PAT + entradas de task_activity com actor PAT. */
  agentActions: number;
}

export async function getMonthInsights(env: Env, year: number, month: number): Promise<MonthInsights> {
  const { start, end } = monthWindowBrt(year, month);

  // Um batch só (D1 cobra por round-trip): cada statement é um agregado pequeno
  // sobre índice de created_at/completed_at — EXPLAIN confirma scan por faixa.
  const [weeks, kinds, domains, edges, connected, tasks, agentNotes, agentActivity] = await env.DB.batch([
    // Captura por semana do mês (bucket = (created_at - start) / 7d).
    env.DB.prepare(
      `SELECT CAST((created_at - ?1) / ${WEEK_MS} AS INTEGER) AS w, COUNT(*) AS c
       FROM notes
       WHERE deleted_at IS NULL AND (kind IS NULL OR kind != 'task')
         AND created_at >= ?1 AND created_at < ?2
       GROUP BY w`
    ).bind(start, end),
    env.DB.prepare(
      `SELECT COALESCE(kind, 'sem tipo') AS kind, COUNT(*) AS c
       FROM notes
       WHERE deleted_at IS NULL AND (kind IS NULL OR kind != 'task')
         AND created_at >= ? AND created_at < ?
       GROUP BY kind ORDER BY c DESC`
    ).bind(start, end),
    env.DB.prepare(
      `SELECT j.value AS domain, COUNT(*) AS c
       FROM notes n, json_each(n.domains) j
       WHERE n.deleted_at IS NULL AND (n.kind IS NULL OR n.kind != 'task')
         AND n.created_at >= ? AND n.created_at < ?
       GROUP BY j.value ORDER BY c DESC LIMIT 5`
    ).bind(start, end),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM edges e
       JOIN notes a ON a.id = e.from_id AND a.deleted_at IS NULL
       JOIN notes b ON b.id = e.to_id AND b.deleted_at IS NULL
       WHERE e.created_at >= ? AND e.created_at < ?`
    ).bind(start, end),
    // Nota mais conectada do mês: grau = pontas (from+to) das edges do mês.
    env.DB.prepare(
      `SELECT n.id, n.title, n.private, COUNT(*) AS degree FROM (
         SELECT e.from_id AS nid FROM edges e
           JOIN notes b ON b.id = e.to_id AND b.deleted_at IS NULL
           WHERE e.created_at >= ?1 AND e.created_at < ?2
         UNION ALL
         SELECT e.to_id AS nid FROM edges e
           JOIN notes a ON a.id = e.from_id AND a.deleted_at IS NULL
           WHERE e.created_at >= ?1 AND e.created_at < ?2
       ) p JOIN notes n ON n.id = p.nid AND n.deleted_at IS NULL
       GROUP BY n.id ORDER BY degree DESC, n.created_at ASC LIMIT 1`
    ).bind(start, end),
    // Execução: done do mês, dividida por autoria da CONCLUSÃO (updated_by —
    // completeTask grava o actor; 'oauth:%' = console do dono, PAT = agente,
    // NULL = linha antiga sem autoria, contada como dono).
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN updated_by IS NOT NULL AND updated_by NOT LIKE 'oauth:%' THEN 1 ELSE 0 END) AS by_agent
       FROM notes
       WHERE kind = 'task' AND status = 'done' AND deleted_at IS NULL
         AND completed_at >= ? AND completed_at < ?`
    ).bind(start, end),
    // Frota: escritas de agentes no mês (notas criadas por PAT + atividade de task).
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM notes
       WHERE created_by IS NOT NULL AND created_by NOT LIKE 'oauth:%'
         AND created_at >= ? AND created_at < ?`
    ).bind(start, end),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM task_activity
       WHERE actor IS NOT NULL AND actor NOT LIKE 'oauth:%'
         AND at >= ? AND at < ?`
    ).bind(start, end),
  ]);

  const daysInMonth = Math.round((end - start) / (24 * 60 * 60 * 1000));
  const byWeek = new Array<number>(Math.ceil(daysInMonth / 7)).fill(0);
  let captured = 0;
  for (const row of (weeks.results ?? []) as { w: number; c: number }[]) {
    if (row.w >= 0 && row.w < byWeek.length) byWeek[row.w] = row.c;
    captured += row.c;
  }

  const conn = (connected.results ?? [])[0] as
    | { id: string; title: string; private: number; degree: number }
    | undefined;
  const taskRow = (tasks.results ?? [])[0] as { total: number; by_agent: number | null } | undefined;
  const tasksDone = taskRow?.total ?? 0;
  const tasksDoneAgent = taskRow?.by_agent ?? 0;

  return {
    year,
    month,
    captured,
    byWeek,
    byKind: ((kinds.results ?? []) as { kind: string; c: number }[]),
    byDomain: ((domains.results ?? []) as { domain: string; c: number }[]),
    edgesCreated: ((edges.results ?? [])[0] as { c: number } | undefined)?.c ?? 0,
    mostConnected: conn
      ? { id: conn.id, title: conn.title, private: conn.private === 1, degree: conn.degree }
      : null,
    tasksDone,
    tasksDoneOwner: tasksDone - tasksDoneAgent,
    tasksDoneAgent,
    agentActions:
      (((agentNotes.results ?? [])[0] as { c: number } | undefined)?.c ?? 0) +
      (((agentActivity.results ?? [])[0] as { c: number } | undefined)?.c ?? 0),
  };
}

// Cache do payload mensal no KV (GRAPH_CACHE, mesmo namespace de trabalho dos
// crons): mês corrente muda o tempo todo → TTL 1h; mês FECHADO é imutável →
// TTL 7d. Falha de KV degrada pra query direta (best-effort).
export async function getMonthInsightsCached(
  env: Env, year: number, month: number, now: number
): Promise<MonthInsights> {
  const cur = brtYearMonth(now);
  const isCurrent = cur.year === year && cur.month === month;
  const key = `insights:v1:${year}-${String(month).padStart(2, '0')}`;
  try {
    const hit = await env.GRAPH_CACHE.get(key);
    if (hit) return JSON.parse(hit) as MonthInsights;
  } catch (e) {
    console.error('insights: falha lendo cache KV (query direta)', e);
  }
  const data = await getMonthInsights(env, year, month);
  try {
    await env.GRAPH_CACHE.put(key, JSON.stringify(data), {
      expirationTtl: isCurrent ? 3600 : 7 * 24 * 3600,
    });
  } catch (e) {
    console.error('insights: falha gravando cache KV (seguindo sem cache)', e);
  }
  return data;
}
