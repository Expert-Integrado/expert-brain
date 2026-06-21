import type { Env } from '../env.js';

export const EDGE_TYPES = [
  'analogous_to','same_mechanism_as','instance_of','generalizes',
  'causes','depends_on','contradicts','evidence_for','refines',
] as const;
export type EdgeType = typeof EDGE_TYPES[number];

// Os 7 kinds de CONHECIMENTO. save_note só aceita estes — task tem caminho próprio
// (save_task), pra não arrastar o fluxo de recall/edges/Feynman pra cima de um to-do.
export const KNOWLEDGE_KINDS = [
  'concept','decision','insight','fact',
  'pattern','principle','question',
] as const;
export type KnowledgeKind = typeof KNOWLEDGE_KINDS[number];

// Todos os kinds da tabela notes. 'task' é to-do operacional migrado do ClickUp:
// mora na MESMA tabela (kind='task' + colunas status/due_at/priority/completed_at),
// mas é EXCLUÍDO do grafo, do recall (não embeda) e da lista de notas. Acesso via
// /app/tasks (Kanban) e as tools save_task/list_tasks_due_today/complete_task.
// Ver migration 0006_task_fields.
export const NOTE_KINDS = [...KNOWLEDGE_KINDS, 'task'] as const;
export type NoteKind = typeof NOTE_KINDS[number];

export const TASK_STATUSES = ['open','in_progress','done','canceled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

// Filtro reutilizado por todos os read paths de CONHECIMENTO (grafo, lista de
// notas, stats, FTS, meta) pra esconder os to-dos. `kind IS NULL` cobre notas
// legadas sem kind; `kind <> 'task'` esconde os tasks.
export const NON_TASK_FILTER = `(kind IS NULL OR kind <> 'task')`;

export interface NoteRow {
  id: string; title: string; body: string; tldr: string;
  domains: string; kind: string | null;
  created_at: number; updated_at: number;
  deleted_at?: number | null; // soft-delete: null = viva, timestamp = na lixeira
}

export interface EdgeRow {
  id: string; from_id: string; to_id: string;
  relation_type: EdgeType; why: string; created_at: number;
}

export interface SimilarEdgeRow { from_id: string; to_id: string; score: number; }

export async function insertNote(env: Env, n: NoteRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(n.id, n.title, n.body, n.tldr, n.domains, n.kind, n.created_at, n.updated_at).run();
}

export async function insertEdge(env: Env, e: EdgeRow): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO edges (id,from_id,to_id,relation_type,why,created_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(e.id, e.from_id, e.to_id, e.relation_type, e.why, e.created_at).run();
}

export async function insertTags(env: Env, noteId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const stmt = env.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`);
  await env.DB.batch(tags.map((t) => stmt.bind(noteId, t)));
}

// Substitui as similar edges de UMA nota (from_id = fromId) pelo novo conjunto.
// DELETE + INSERTs vão num único env.DB.batch (1 subrequest D1, transacional) —
// crítico pro backfill caber no cap de subrequests do Cloudflare. Chamado pelo
// write path após o upsert do vetor. Ver migration 0005.
export async function replaceSimilarEdges(
  env: Env, fromId: string, neighbors: Array<{ to_id: string; score: number }>
): Promise<void> {
  const del = env.DB.prepare(`DELETE FROM similar_edges WHERE from_id = ?`).bind(fromId);
  if (neighbors.length === 0) {
    await del.run();
    return;
  }
  const ins = env.DB.prepare(`INSERT OR IGNORE INTO similar_edges (from_id, to_id, score) VALUES (?, ?, ?)`);
  await env.DB.batch([del, ...neighbors.map((n) => ins.bind(fromId, n.to_id, n.score))]);
}

// Lê TODAS as similar edges. O filtro por nota viva e a deduplicação de pares
// simétricos/explícitos ficam no read path do grafo (graph-data.ts), que já tem
// o conjunto de notas vivas e de pares explícitos em mãos.
export async function getAllSimilarEdges(env: Env): Promise<SimilarEdgeRow[]> {
  const r = await env.DB.prepare(
    `SELECT from_id, to_id, score FROM similar_edges`
  ).all<SimilarEdgeRow>();
  return r.results ?? [];
}

export interface NotePatch {
  title?: string;
  body?: string;
  tldr?: string;
  domains?: string;
  kind?: NoteKind;
  updated_at: number;
}

export async function updateNote(env: Env, id: string, patch: NotePatch): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) { fields.push('title = ?'); values.push(patch.title); }
  if (patch.body !== undefined) { fields.push('body = ?'); values.push(patch.body); }
  if (patch.tldr !== undefined) { fields.push('tldr = ?'); values.push(patch.tldr); }
  if (patch.domains !== undefined) { fields.push('domains = ?'); values.push(patch.domains); }
  if (patch.kind !== undefined) { fields.push('kind = ?'); values.push(patch.kind); }
  fields.push('updated_at = ?'); values.push(patch.updated_at);
  values.push(id);
  await env.DB.prepare(
    `UPDATE notes SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();
}

// Soft-delete: marca deleted_at em vez de apagar a linha. A nota some de todos
// os read paths (que filtram deleted_at IS NULL) mas o conteudo + as edges
// continuam no D1, recuperaveis via restoreNote. `AND deleted_at IS NULL` evita
// sobrescrever o timestamp original num delete duplicado.
export async function deleteNote(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .bind(Date.now(), id).run();
}

// Restaura uma nota soft-deletada (re-embed do vetor fica a cargo do caller).
export async function restoreNote(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE notes SET deleted_at = NULL WHERE id = ?`).bind(id).run();
}

export async function replaceTags(env: Env, noteId: string, tags: string[]): Promise<void> {
  await env.DB.prepare(`DELETE FROM tags WHERE note_id = ?`).bind(noteId).run();
  if (tags.length > 0) {
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`);
    await env.DB.batch(tags.map((t) => stmt.bind(noteId, t)));
  }
}

// Por padrao ignora notas soft-deletadas (deleted_at IS NULL). includeDeleted=true
// e usado só pelo restore_note, que precisa ler a nota na lixeira pra recuperar.
export async function getNoteById(env: Env, id: string, includeDeleted = false): Promise<NoteRow | null> {
  const sql = includeDeleted
    ? `SELECT * FROM notes WHERE id = ?`
    : `SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL`;
  return env.DB.prepare(sql).bind(id).first<NoteRow>();
}

export async function getTagsByNote(env: Env, id: string): Promise<string[]> {
  const r = await env.DB.prepare(`SELECT tag FROM tags WHERE note_id = ?`).bind(id).all<{ tag: string }>();
  return (r.results ?? []).map((x) => x.tag);
}

// Edges cujo OUTRO extremo esteja soft-deletado sao filtradas (o JOIN garante
// que a nota vizinha esta viva). Soft-delete nao cascateia (a linha fica), entao
// sem esse filtro apareceriam edges fantasma pra notas na lixeira.
export async function getEdgesFrom(env: Env, id: string): Promise<EdgeRow[]> {
  const r = await env.DB.prepare(
    `SELECT e.* FROM edges e JOIN notes n ON n.id = e.to_id
     WHERE e.from_id = ? AND n.deleted_at IS NULL`
  ).bind(id).all<EdgeRow>();
  return r.results ?? [];
}

export async function getEdgesTo(env: Env, id: string): Promise<EdgeRow[]> {
  const r = await env.DB.prepare(
    `SELECT e.* FROM edges e JOIN notes n ON n.id = e.from_id
     WHERE e.to_id = ? AND n.deleted_at IS NULL`
  ).bind(id).all<EdgeRow>();
  return r.results ?? [];
}

function sanitizeFtsQuery(raw: string, prefix = false): string | null {
  // FTS5: AND/OR/NOT/NEAR são operadores (case-insensitive). Tokens já vêm só
  // com letras/números; em modo prefixo uso `token*` (bareword + estrela), mas
  // guardo os operadores entre aspas pra não virarem sintaxe. Sem prefixo,
  // mantém o termo exato entre aspas (comportamento usado pelo recall).
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
    .map((t) => {
      if (!prefix) return `"${t}"`;
      return /^(and|or|not|near)$/i.test(t) ? `"${t}"` : `${t}*`;
    });
  return tokens.length === 0 ? null : tokens.join(' OR ');
}

export async function ftsSearch(
  env: Env, query: string, limit: number, prefix = false
): Promise<Array<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>> {
  const safe = sanitizeFtsQuery(query, prefix);
  if (!safe) return [];
  const r = await env.DB.prepare(
    `SELECT n.id, n.title, n.tldr, n.domains, n.kind
     FROM notes_fts f
     JOIN notes n ON n.rowid = f.rowid
     WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
       AND (n.kind IS NULL OR n.kind <> 'task')
     ORDER BY rank
     LIMIT ?`
  ).bind(safe, limit).all<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>();
  return r.results ?? [];
}

// ───────────────────────────── TASKS ─────────────────────────────
// Tasks são notas (kind='task') com 4 colunas extras. Estas funções leem/escrevem
// SÓ tasks e nunca tocam Vectorize — o to-do não vira vetor (mantém o recall limpo).

export interface TaskRow {
  id: string; title: string; body: string; tldr: string; domains: string;
  kind: string | null;
  status: string | null; due_at: number | null;
  priority: number | null; completed_at: number | null;
  created_at: number; updated_at: number;
}

export interface InsertTaskInput {
  id: string; title: string; body: string; tldr: string; domains: string;
  status: TaskStatus; due_at: number | null; priority: number | null;
  created_at: number; updated_at: number;
}

const TASK_COLS = `id, title, body, tldr, domains, kind, status, due_at, priority, completed_at, created_at, updated_at`;

// Insere uma task. NÃO embeda — diferente de insertNote, que é seguido por
// upsertNoteVector no save_note. Aqui não há vetor de propósito.
export async function insertTask(env: Env, t: InsertTaskInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,created_at,updated_at)
     VALUES (?,?,?,?,?,'task',?,?,?,?,?)`
  ).bind(t.id, t.title, t.body, t.tldr, t.domains, t.status, t.due_at, t.priority, t.created_at, t.updated_at).run();
}

export async function getTaskById(env: Env, id: string): Promise<TaskRow | null> {
  return env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(id).first<TaskRow>();
}

// Tasks ativas (open + in_progress), ordenadas por vencimento (sem due primeiro? não:
// NULLs por último), depois prioridade (1 = mais alta). Usado pela coluna esquerda do
// Kanban e como base das outras visões.
export async function listActiveTasks(env: Env): Promise<TaskRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND status IN ('open','in_progress')
     ORDER BY (due_at IS NULL) ASC, due_at ASC, COALESCE(priority, 9) ASC, created_at ASC`
  ).all<TaskRow>();
  return r.results ?? [];
}

// Tasks finalizadas (done/canceled) mais recentes — limitadas pra a coluna direita
// do Kanban não crescer pra sempre conforme o histórico acumula.
export async function listRecentClosedTasks(env: Env, limit = 100): Promise<TaskRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND status IN ('done','canceled')
     ORDER BY COALESCE(completed_at, updated_at) DESC
     LIMIT ?`
  ).bind(limit).all<TaskRow>();
  return r.results ?? [];
}

// Tasks que vencem até `beforeMs` (inclui as já vencidas, pois due_at < now < beforeMs).
// Só conta tasks com due_at definido e ainda abertas. Ordenadas por vencimento +
// prioridade. Base do list_tasks_due_today e do lembrete da VPS.
export async function listTasksDueBefore(env: Env, beforeMs: number): Promise<TaskRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL
       AND status IN ('open','in_progress')
       AND due_at IS NOT NULL AND due_at <= ?
     ORDER BY due_at ASC, COALESCE(priority, 9) ASC`
  ).bind(beforeMs).all<TaskRow>();
  return r.results ?? [];
}

// Muda o status de uma task. Ao marcar done/canceled grava completed_at=now; ao
// reabrir (open/in_progress) limpa completed_at. Retorna false se o id não é uma task.
export async function setTaskStatus(env: Env, id: string, status: TaskStatus, now: number): Promise<boolean> {
  const closing = status === 'done' || status === 'canceled';
  const res = await env.DB.prepare(
    `UPDATE notes SET status = ?, completed_at = ${closing ? '?' : 'NULL'}, updated_at = ?
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(...(closing ? [status, now, now, id] : [status, now, id])).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Conclui uma task (status=done, completed_at=now). Se `outcome` vier, faz append
// no corpo como "**Resultado:** ...". Retorna a task atualizada ou null.
export async function completeTask(env: Env, id: string, now: number, outcome?: string): Promise<TaskRow | null> {
  const task = await getTaskById(env, id);
  if (!task) return null;
  const body = outcome && outcome.trim()
    ? `${task.body}\n\n**Resultado:** ${outcome.trim()}`
    : task.body;
  await env.DB.prepare(
    `UPDATE notes SET status = 'done', completed_at = ?, updated_at = ?, body = ?
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(now, now, body, id).run();
  return { ...task, status: 'done', completed_at: now, updated_at: now, body };
}
