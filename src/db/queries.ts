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

// Retorna true se a edge foi inserida; false se já existia (INSERT OR IGNORE na
// UNIQUE(from_id,to_id,relation_type)). O caller decide como reportar — o link
// evita fabricar um id inexistente na resposta de duplicata. Ver spec 16.
export async function insertEdge(env: Env, e: EdgeRow): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO edges (id,from_id,to_id,relation_type,why,created_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(e.id, e.from_id, e.to_id, e.relation_type, e.why, e.created_at).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Remove uma edge pela chave natural (from_id, to_id, relation_type). Retorna true
// se removeu, false se não existia. Hard delete: edge não tem soft-delete (recriar
// via link é barato e o `why` removido é devolvido na resposta como registro).
export async function deleteEdge(
  env: Env, fromId: string, toId: string, relationType: EdgeType
): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM edges WHERE from_id = ? AND to_id = ? AND relation_type = ?`
  ).bind(fromId, toId, relationType).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Lê UMA edge pela chave natural. Usado pelo delete_link pra citar o `why` na
// resposta antes de remover.
export async function getEdge(
  env: Env, fromId: string, toId: string, relationType: EdgeType
): Promise<EdgeRow | null> {
  return env.DB.prepare(
    `SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND relation_type = ?`
  ).bind(fromId, toId, relationType).first<EdgeRow>();
}

// Normaliza tags pro formato canônico: lowercase + trim, sem vazias. A LEITURA
// (filtro de tag no list_tasks) também normaliza, então tags antigas com maiúscula
// continuam matcháveis sem precisar de migration. Ver spec 15 item 7.
function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

export async function insertTags(env: Env, noteId: string, tags: string[]): Promise<void> {
  const norm = normalizeTags(tags);
  if (norm.length === 0) return;
  const stmt = env.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`);
  await env.DB.batch(norm.map((t) => stmt.bind(noteId, t)));
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
  const norm = normalizeTags(tags);
  if (norm.length > 0) {
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`);
    await env.DB.batch(norm.map((t) => stmt.bind(noteId, t)));
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

// Tags de VÁRIAS notas numa query (chunked p/ não estourar binds do D1). Usado pelo
// list_tasks pra devolver as tags de cada task sem N+1 — habilita dedup ("essa task já
// existe?") e a convenção de tag de máquina (maquina:pc / maquina:vps).
export async function getTagsForNotes(env: Env, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT note_id, tag FROM tags WHERE note_id IN (${ph})`
    ).bind(...chunk).all<{ note_id: string; tag: string }>();
    for (const row of r.results ?? []) {
      const arr = out.get(row.note_id) ?? [];
      arr.push(row.tag);
      out.set(row.note_id, arr);
    }
  }
  return out;
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

// Hidrata VÁRIAS notas de CONHECIMENTO por id (chunked p/ não estourar o cap de ~100
// binds do D1, mesmo padrão de getTagsForNotes). Aplica NON_TASK_FILTER: qualquer id
// de task no pool é dropado aqui — defesa em profundidade pro recall (o retrieval por
// domínio já exclui task, mas isto garante que nenhuma fonte futura de ids reabra o
// vazamento). Seleciona só as 5 colunas leves que o recall usa (sem body).
export async function getNotesByIds(
  env: Env, ids: string[]
): Promise<Array<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>> {
  const out: Array<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>> = [];
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT id, title, tldr, domains, kind FROM notes
       WHERE id IN (${ph}) AND deleted_at IS NULL AND ${NON_TASK_FILTER}`
    ).bind(...chunk).all<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>();
    out.push(...(r.results ?? []));
  }
  return out;
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
// (TaskRow/InsertTaskInput/TASK_COLS declarados abaixo; ftsSearchTasks fica lá.)
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
  // Aditivo: quando a task nasce fechada (done/canceled), stampar completed_at
  // preserva o invariante "fechada ⇒ completed_at preenchido" mantido por
  // setTaskStatus/updateTask/completeTask. Chamadores antigos passam null/omitem.
  completed_at?: number | null;
}

const TASK_COLS = `id, title, body, tldr, domains, kind, status, due_at, priority, completed_at, created_at, updated_at`;

// Busca FTS restrita a TASKS — o espelho do ftsSearch, que as exclui. As linhas de
// task JÁ estão no notes_fts (os triggers da migration 0001 indexam TODAS as notas);
// aqui só se ABRE o caminho de leitura. Zero migration. Usa prefix=true (busca
// exploratória p/ dedupe por fragmento de título). Devolve TaskRow completo — o
// list_tasks precisa de status/due/priority pra montar o card. Ver spec 15 item 1.
export async function ftsSearchTasks(env: Env, query: string, limit: number): Promise<TaskRow[]> {
  const safe = sanitizeFtsQuery(query, true);
  if (!safe) return [];
  const cols = TASK_COLS.split(', ').map((c) => `n.${c}`).join(', ');
  const r = await env.DB.prepare(
    `SELECT ${cols}
     FROM notes_fts f
     JOIN notes n ON n.rowid = f.rowid
     WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND n.kind = 'task'
     ORDER BY rank
     LIMIT ?`
  ).bind(safe, limit).all<TaskRow>();
  return r.results ?? [];
}

// Insere uma task. NÃO embeda — diferente de insertNote, que é seguido por
// upsertNoteVector no save_note. Aqui não há vetor de propósito.
export async function insertTask(env: Env, t: InsertTaskInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'task',?,?,?,?,?,?)`
  ).bind(t.id, t.title, t.body, t.tldr, t.domains, t.status, t.due_at, t.priority, t.completed_at ?? null, t.created_at, t.updated_at).run();
}

// Procura UMA task ativa (open/in_progress, viva) que carregue a tag dada. Usado
// pelo dedupe do save_task: a dedupe_key é persistida como tag reservada
// `dedupe:<key>`. Check-then-insert não é atômico sem constraint UNIQUE, mas a
// janela residual é de milissegundos — o alvo é matar retry de rede e criação por
// convenção, não tráfego adversarial. Só bate contra tasks ATIVAS: uma dedupe_key
// de task já concluída não bloqueia recriar.
export async function findActiveTaskByTag(env: Env, tag: string): Promise<TaskRow | null> {
  return env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes n
     JOIN tags t ON t.note_id = n.id
     WHERE t.tag = ? AND n.kind = 'task' AND n.deleted_at IS NULL
       AND n.status IN ('open','in_progress')
     LIMIT 1`
  ).bind(tag).first<TaskRow>();
}

// Match barato de possível duplicata por título (aviso, NÃO bloqueia). Bate contra
// tasks ativas por LIKE case-insensitive (NOCASE só normaliza ASCII — acento não
// casa; aceitável pra um warning). LIMIT 5. O `title LIKE ?` recebe %<titulo>%.
export async function findSimilarActiveTasksByTitle(
  env: Env, title: string
): Promise<Array<Pick<TaskRow,'id'|'title'|'status'|'due_at'>>> {
  const pat = `%${title.trim()}%`;
  const r = await env.DB.prepare(
    `SELECT id, title, status, due_at FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND status IN ('open','in_progress')
       AND title LIKE ? COLLATE NOCASE
     LIMIT 5`
  ).bind(pat).all<Pick<TaskRow,'id'|'title'|'status'|'due_at'>>();
  return r.results ?? [];
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
    // LIMIT 500 defensivo = teto do `limit` da tool list_tasks; evita puxar milhares
    // de tasks abertas num vault que cresceu (o slice da tool já corta, mas o SQL não
    // deve materializar tudo). Ver spec 15 item 8.
    `SELECT ${TASK_COLS} FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND status IN ('open','in_progress')
     ORDER BY (due_at IS NULL) ASC, due_at ASC, COALESCE(priority, 9) ASC, created_at ASC
     LIMIT 500`
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

// Resultado de completeTask/updateTask: a task atualizada, ou um sentinel de
// controle. 'not-found' = id não é task (ou soft-deletada). 'conflict' =
// versionamento otimista falhou (a task mudou desde a leitura do cliente).
// 'already-done' = idempotência: a task já estava done, nada foi escrito.
export type CompleteResult = TaskRow | 'not-found' | 'conflict' | 'already-done';
export type UpdateResult = TaskRow | 'not-found' | 'conflict';

// Conclui uma task (status=done, completed_at=now). Se `outcome` vier, faz APPEND
// no corpo como "**Resultado:** ..." num único UPDATE SQL — sem read-modify-write
// em JS, então não há janela de corrida (dois completes intercalados não perdem
// outcome). O `AND status <> 'done'` garante idempotência mesmo sob corrida: o
// segundo complete afeta 0 linhas e cai em 'already-done'. `expectedUpdatedAt`
// (opt-in) adiciona If-Match: só escreve se updated_at ainda for o lido.
export async function completeTask(
  env: Env, id: string, now: number, outcome?: string, expectedUpdatedAt?: number
): Promise<CompleteResult> {
  const before = await getTaskById(env, id);
  if (!before) return 'not-found';
  // Idempotência: já concluída → no-op (não re-appenda o body, não avança timestamps).
  if (before.status === 'done') return 'already-done';
  // Versionamento otimista opt-in: se o cliente informou o updated_at que leu e a
  // task mudou desde então, não escrever.
  if (expectedUpdatedAt !== undefined && before.updated_at !== expectedUpdatedAt) {
    return 'conflict';
  }

  const trimmed = outcome && outcome.trim() ? outcome.trim() : null;
  const res = await env.DB.prepare(
    `UPDATE notes
     SET status = 'done',
         completed_at = ?,
         updated_at = ?,
         body = CASE WHEN ? IS NULL THEN body
                     ELSE body || char(10) || char(10) || '**Resultado:** ' || ? END
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL
       AND status <> 'done'
       AND (? IS NULL OR updated_at = ?)`
  ).bind(now, now, trimmed, trimmed, id, expectedUpdatedAt ?? null, expectedUpdatedAt ?? null).run();

  if ((res.meta?.changes ?? 0) === 0) {
    // Alguém venceu a corrida ou a versão não bateu. Reler pra decidir o sentinel.
    const after = await getTaskById(env, id);
    if (!after) return 'not-found';
    if (after.status === 'done') return 'already-done';
    return 'conflict';
  }

  const after = await getTaskById(env, id);
  return after ?? 'not-found';
}

// Campos editáveis de uma task. Todos opcionais — só os presentes entram no UPDATE.
// due_at aceita null pra LIMPAR o vencimento (diferente de omitir, que mantém).
export interface TaskPatch {
  title?: string;
  body?: string;
  due_at?: number | null;
  priority?: number | null;
  status?: TaskStatus;
  domains?: string; // JSON string, igual ao insertTask
}

// Edita campos de uma task existente. Faz UPDATE só das colunas presentes no patch
// (patch parcial, espelha updateNote mas pra tasks). NÃO toca Vectorize — task não
// tem vetor de propósito. Valida que o id é kind='task' (como completeTask): retorna
// 'not-found' se não for. Mudar title atualiza o tldr junto (tldr de task espelha o
// título). Status pra done/canceled grava completed_at=now; reabrir limpa.
// `expectedUpdatedAt` (opt-in) adiciona versionamento otimista If-Match: o UPDATE
// ganha `AND updated_at = ?` e, se 0 linhas mudarem numa task que existe, retorna
// 'conflict' (escrita concorrente detectada). Sem o parâmetro, comportamento
// last-write-wins idêntico ao anterior (retrocompatível).
export async function updateTask(
  env: Env, id: string, patch: TaskPatch, now: number, expectedUpdatedAt?: number
): Promise<UpdateResult> {
  const task = await getTaskById(env, id);
  if (!task) return 'not-found';

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?'); binds.push(patch.title);
    sets.push('tldr = ?'); binds.push(patch.title.slice(0, 280));
  }
  if (patch.body !== undefined) { sets.push('body = ?'); binds.push(patch.body); }
  if (patch.due_at !== undefined) { sets.push('due_at = ?'); binds.push(patch.due_at); }
  if (patch.priority !== undefined) { sets.push('priority = ?'); binds.push(patch.priority); }
  if (patch.domains !== undefined) { sets.push('domains = ?'); binds.push(patch.domains); }
  if (patch.status !== undefined) {
    const closing = patch.status === 'done' || patch.status === 'canceled';
    sets.push('status = ?'); binds.push(patch.status);
    sets.push(`completed_at = ${closing ? '?' : 'NULL'}`);
    if (closing) binds.push(now);
  }
  sets.push('updated_at = ?'); binds.push(now);

  let where = `id = ? AND kind = 'task' AND deleted_at IS NULL`;
  binds.push(id);
  if (expectedUpdatedAt !== undefined) {
    where += ` AND updated_at = ?`;
    binds.push(expectedUpdatedAt);
  }

  const res = await env.DB.prepare(
    `UPDATE notes SET ${sets.join(', ')} WHERE ${where}`
  ).bind(...binds).run();

  // Com versionamento: 0 linhas numa task que existe = conflito de versão (a task
  // mudou desde a leitura do cliente).
  if (expectedUpdatedAt !== undefined && (res.meta?.changes ?? 0) === 0) {
    return 'conflict';
  }

  const after = await getTaskById(env, id);
  return after ?? 'not-found';
}
