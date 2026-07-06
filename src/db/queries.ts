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

// ─────────────────────────── KANBAN COLUMNS ───────────────────────────
// Colunas/estágios customizáveis do board (migration 0009). `notes.status` continua
// a fonte canônica de ESTADO (4 categorias imutáveis); `kanban_columns.category`
// AMARRA cada coluna a uma dessas 4 categorias e `notes.column_id` é o estágio
// VISUAL. Invariante mantido server-side: category(column_id) == notes.status.
// Ver spec 50-console-v2/51.
export interface KanbanColumn {
  id: string;
  label: string;
  color: string | null;      // hex #rrggbb; null = neutro do tema
  position: number;
  category: TaskStatus;
  archived_at: number | null; // coluna arquivada não renderiza no board
}

// Seed fixo por categoria — usado como fallback quando não existe coluna ATIVA da
// categoria (ex.: canceladas com col_cancelado arquivado). Espelha os seeds da
// migration 0009. NUNCA muda (slugs estáveis).
export const SEED_COLUMN_BY_CATEGORY: Record<TaskStatus, string> = {
  open: 'col_aberto',
  in_progress: 'col_progresso',
  done: 'col_concluido',
  canceled: 'col_cancelado',
};

// Filtro reutilizado por todos os read paths de CONHECIMENTO (grafo, lista de
// notas, stats, FTS, meta) pra esconder os to-dos. `kind IS NULL` cobre notas
// legadas sem kind; `kind <> 'task'` esconde os tasks.
export const NON_TASK_FILTER = `(kind IS NULL OR kind <> 'task')`;

// Fragmento de visibilidade do SELO DE PRIVACIDADE (spec 30-features/31), espelhando
// a convenção do soft-delete: uma constante única citada em TODOS os read paths pra
// que o filtro não divirja entre superfícies. `private` é INTEGER 0/1 NOT NULL DEFAULT 0
// (migration 0013). Aplicado a uma credencial SEM o escopo `private` (fail-closed): a
// nota privada some de recall/FTS/get_note/expand/stats. A sessão web do dono e o PAT
// COM escopo `private` passam includePrivate=true e veem tudo.
export const PUBLIC_ONLY_FILTER = `private = 0`;

export interface NoteRow {
  id: string; title: string; body: string; tldr: string;
  domains: string; kind: string | null;
  created_at: number; updated_at: number;
  deleted_at?: number | null; // soft-delete: null = viva, timestamp = na lixeira
  private?: number; // selo de privacidade (spec 31): 0 = pública (default), 1 = privada
}

export interface EdgeRow {
  id: string; from_id: string; to_id: string;
  relation_type: EdgeType; why: string; created_at: number;
}

export interface SimilarEdgeRow { from_id: string; to_id: string; score: number; }

// `actor` (opt-in, spec 17) grava a autoria da escrita: id do PAT que criou a nota,
// ou `oauth:<email>` numa sessão OAuth. Ausente → NULL (chamadas web/legadas), zero
// mudança de comportamento. Numa nota recém-criada created_by == updated_by == actor.
export async function insertNote(env: Env, n: NoteRow, actor?: string | null): Promise<void> {
  await env.DB.prepare(
    // `private` (spec 31): parâmetro aditivo, default 0 (pública). Chamadas que não
    // passam n.private caem no DEFAULT da coluna — zero mudança de comportamento.
    `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_by,updated_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(n.id, n.title, n.body, n.tldr, n.domains, n.kind, n.private ?? 0, actor ?? null, actor ?? null, n.created_at, n.updated_at).run();
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
// MANTIDA: consumida por test/queries.test.ts. O grafo usa getTopSimilarEdges.
export async function getAllSimilarEdges(env: Env): Promise<SimilarEdgeRow[]> {
  const r = await env.DB.prepare(
    `SELECT from_id, to_id, score FROM similar_edges`
  ).all<SimilarEdgeRow>();
  return r.results ?? [];
}

// Cap de leitura: só o top-N vizinhos por from_id, ordenados por score desc
// (desempate determinístico por to_id). Window function do SQLite/D1. O write
// path continua gravando SIMILARITY_TOP_K (=4); este cap é read-only e reversível
// por config — reduz o payload do grafo em escala sem tocar na tabela. Ver spec 26.
export async function getTopSimilarEdges(env: Env, perNode: number): Promise<SimilarEdgeRow[]> {
  const r = await env.DB.prepare(
    `SELECT from_id, to_id, score FROM (
       SELECT from_id, to_id, score,
              ROW_NUMBER() OVER (PARTITION BY from_id ORDER BY score DESC, to_id) AS rn
       FROM similar_edges
     ) WHERE rn <= ?`
  ).bind(perNode).all<SimilarEdgeRow>();
  return r.results ?? [];
}

export interface NotePatch {
  title?: string;
  body?: string;
  tldr?: string;
  domains?: string;
  kind?: NoteKind;
  // Selo de privacidade (spec 31): 1 = marca privada, 0 = torna pública. A tool MCP
  // update_note só passa 1 (marcar); desmarcar (0) é exclusivo da UI logada do dono
  // (setNotePrivate via POST /app/notes/{id}/private). Omitir → não mexe.
  private?: 0 | 1;
  updated_at: number;
}

// Resultado do updateNote com versionamento otimista: 'ok' quando gravou,
// 'conflict' quando `expectedUpdatedAt` foi passado e 0 linhas mudaram (a nota
// existe mas o updated_at não bateu — escrita concorrente). Espelha o sentinel
// de updateTask, mas updateNote não relê a linha (o caller já tem `existing`).
export type NoteUpdateResult = 'ok' | 'conflict';

// Edita colunas de uma nota. `expectedUpdatedAt` (opt-in) adiciona versionamento
// otimista If-Match: o UPDATE ganha `AND updated_at = ?` e, se 0 linhas mudarem,
// retorna 'conflict'. Sem o parâmetro, comportamento last-write-wins idêntico ao
// anterior (retrocompatível — as chamadas existentes seguem funcionando e sempre
// recebem 'ok'). Espelha o padrão já validado em updateTask.
export async function updateNote(
  env: Env, id: string, patch: NotePatch, expectedUpdatedAt?: number, actor?: string | null
): Promise<NoteUpdateResult> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) { fields.push('title = ?'); values.push(patch.title); }
  if (patch.body !== undefined) { fields.push('body = ?'); values.push(patch.body); }
  if (patch.tldr !== undefined) { fields.push('tldr = ?'); values.push(patch.tldr); }
  if (patch.domains !== undefined) { fields.push('domains = ?'); values.push(patch.domains); }
  if (patch.kind !== undefined) { fields.push('kind = ?'); values.push(patch.kind); }
  if (patch.private !== undefined) { fields.push('private = ?'); values.push(patch.private); }
  fields.push('updated_at = ?'); values.push(patch.updated_at);
  // Autoria (spec 17): COALESCE preserva o updated_by anterior quando o caller não
  // passa actor (edições web/legadas) — bind null vira no-op, zero mudança.
  fields.push('updated_by = COALESCE(?, updated_by)'); values.push(actor ?? null);

  let where = `id = ?`;
  values.push(id);
  if (expectedUpdatedAt !== undefined) {
    where += ` AND updated_at = ?`;
    values.push(expectedUpdatedAt);
  }

  const res = await env.DB.prepare(
    `UPDATE notes SET ${fields.join(', ')} WHERE ${where}`
  ).bind(...values).run();

  if (expectedUpdatedAt !== undefined && (res.meta?.changes ?? 0) === 0) {
    return 'conflict';
  }
  return 'ok';
}

// Soft-delete: marca deleted_at em vez de apagar a linha. A nota some de todos
// os read paths (que filtram deleted_at IS NULL) mas o conteudo + as edges
// continuam no D1, recuperaveis via restoreNote. `AND deleted_at IS NULL` evita
// sobrescrever o timestamp original num delete duplicado.
export async function deleteNote(env: Env, id: string, actor?: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE notes SET deleted_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ? AND deleted_at IS NULL`)
    .bind(Date.now(), actor ?? null, id).run();
}

// Restaura uma nota soft-deletada (re-embed do vetor fica a cargo do caller).
export async function restoreNote(env: Env, id: string, actor?: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE notes SET deleted_at = NULL, updated_by = COALESCE(?, updated_by) WHERE id = ?`).bind(actor ?? null, id).run();
}

// Marca/desmarca `private` numa NOTA de conhecimento viva (spec 31). SÓ toca a coluna
// private + updated_at (+ autoria) — NÃO re-embeda (private não altera tldr/domains/kind,
// então não muda o vetor) nem toca similar_edges. `kind <> 'task'` exclui tasks (read
// paths de task são gateados pela spec 59, não aqui). Advancing updated_at invalida o
// cache do grafo (sourceHash inclui MAX(updated_at)), pra o badge/anel de privada
// aparecer/sumir. Retorna true se alterou uma nota (viva, de conhecimento).
export async function setNotePrivate(
  env: Env, id: string, priv: 0 | 1, now: number, actor?: string | null
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE notes SET private = ?, updated_at = ?, updated_by = COALESCE(?, updated_by)
     WHERE id = ? AND deleted_at IS NULL AND ${NON_TASK_FILTER}`
  ).bind(priv, now, actor ?? null, id).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Marca/desmarca `private` numa TASK viva (spec 59). MARCAR privada (priv=1) revoga
// QUALQUER share na MESMA escrita (limpa share_token/share_expires_at) — fail-closed:
// nunca existe o estado (privada + token vivo). Retorna { ok, shareRevoked }: ok=false
// se o id não é uma task viva; shareRevoked=true quando marcou privada E havia token.
// Avança updated_at (+ autoria). NÃO re-embeda (task não tem vetor). O caller decide a
// visibilidade por escopo ANTES (a UI é sessão do dono; a tool checa canSeePrivate).
export async function setTaskPrivate(
  env: Env, id: string, priv: 0 | 1, now: number, actor?: string | null
): Promise<{ ok: boolean; shareRevoked: boolean }> {
  const row = await env.DB.prepare(
    `SELECT share_token FROM notes WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(id).first<{ share_token: string | null }>();
  if (!row) return { ok: false, shareRevoked: false };
  const hadShare = row.share_token != null;
  if (priv === 1) {
    await env.DB.prepare(
      `UPDATE notes SET private = 1, share_token = NULL, share_expires_at = NULL,
              updated_at = ?, updated_by = COALESCE(?, updated_by)
       WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
    ).bind(now, actor ?? null, id).run();
    return { ok: true, shareRevoked: hadShare };
  }
  await env.DB.prepare(
    `UPDATE notes SET private = 0, updated_at = ?, updated_by = COALESCE(?, updated_by)
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(now, actor ?? null, id).run();
  return { ok: true, shareRevoked: false };
}

export async function replaceTags(env: Env, noteId: string, tags: string[]): Promise<void> {
  await env.DB.prepare(`DELETE FROM tags WHERE note_id = ?`).bind(noteId).run();
  const norm = normalizeTags(tags);
  if (norm.length > 0) {
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`);
    await env.DB.batch(norm.map((t) => stmt.bind(noteId, t)));
  }
}

// Substitui as tags de uma TASK preservando as reservadas `dedupe:*` — replaceTags
// apaga tudo, e a dedupe_key sumir silenciosamente reabriria a criação de duplicata
// (ver save_task). Exceção: se o novo array já traz uma tag dedupe: explícita, é
// substituição intencional. Compartilhado por update_task (MCP) e /app/tasks/update
// (UI, spec 52) — mesma regra nos dois caminhos.
export async function replaceTaskTagsPreservingDedupe(env: Env, noteId: string, tags: string[]): Promise<void> {
  let finalTags = tags;
  const bringsDedupe = tags.some((t) => t.startsWith('dedupe:'));
  if (!bringsDedupe) {
    const existing = await getTagsByNote(env, noteId);
    const dedupeTags = existing.filter((t) => t.startsWith('dedupe:'));
    if (dedupeTags.length > 0) finalTags = [...tags, ...dedupeTags];
  }
  await replaceTags(env, noteId, finalTags);
}

// Por padrao ignora notas soft-deletadas (deleted_at IS NULL). includeDeleted=true
// e usado só pelo restore_note, que precisa ler a nota na lixeira pra recuperar.
// includePrivate (spec 31): default false (fail-closed) appenda `AND private = 0`, então
// uma credencial sem escopo `private` recebe null (indistinguível de inexistente — não
// vaza que a nota existe). A sessão do dono e o PAT com escopo passam true e veem tudo.
export async function getNoteById(
  env: Env, id: string, includeDeleted = false, includePrivate = false
): Promise<NoteRow | null> {
  const conds = ['id = ?'];
  if (!includeDeleted) conds.push('deleted_at IS NULL');
  if (!includePrivate) conds.push(PUBLIC_ONLY_FILTER);
  return env.DB.prepare(`SELECT * FROM notes WHERE ${conds.join(' AND ')}`).bind(id).first<NoteRow>();
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
// includePrivate (spec 31): default false appenda `AND n.private = 0` no vizinho, então
// uma nota privada nunca aparece como vizinha (nem via get_note/expand) pra credencial
// sem escopo — mesmo padrão do soft-delete, agora com dois eixos de visibilidade.
export async function getEdgesFrom(env: Env, id: string, includePrivate = false): Promise<EdgeRow[]> {
  const priv = includePrivate ? '' : ` AND n.${PUBLIC_ONLY_FILTER}`;
  const r = await env.DB.prepare(
    `SELECT e.* FROM edges e JOIN notes n ON n.id = e.to_id
     WHERE e.from_id = ? AND n.deleted_at IS NULL${priv}`
  ).bind(id).all<EdgeRow>();
  return r.results ?? [];
}

export async function getEdgesTo(env: Env, id: string, includePrivate = false): Promise<EdgeRow[]> {
  const priv = includePrivate ? '' : ` AND n.${PUBLIC_ONLY_FILTER}`;
  const r = await env.DB.prepare(
    `SELECT e.* FROM edges e JOIN notes n ON n.id = e.from_id
     WHERE e.to_id = ? AND n.deleted_at IS NULL${priv}`
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
  env: Env, ids: string[], includePrivate = false
): Promise<Array<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>> {
  const out: Array<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>> = [];
  if (ids.length === 0) return out;
  // Selo de privacidade (spec 31): default false appenda `AND private = 0`. O Vectorize
  // pode devolver ids de notas privadas no top-30; elas caem AQUI na hidratação pra
  // caller sem escopo (recebe menos resultados, nunca resultados privados).
  const priv = includePrivate ? '' : ` AND ${PUBLIC_ONLY_FILTER}`;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT id, title, tldr, domains, kind FROM notes
       WHERE id IN (${ph}) AND deleted_at IS NULL AND ${NON_TASK_FILTER}${priv}`
    ).bind(...chunk).all<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>();
    out.push(...(r.results ?? []));
  }
  return out;
}

export async function ftsSearch(
  env: Env, query: string, limit: number, prefix = false, includePrivate = false
): Promise<Array<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>> {
  const safe = sanitizeFtsQuery(query, prefix);
  if (!safe) return [];
  // Selo de privacidade (spec 31): default false appenda `AND n.private = 0`.
  const priv = includePrivate ? '' : ` AND n.${PUBLIC_ONLY_FILTER}`;
  const r = await env.DB.prepare(
    `SELECT n.id, n.title, n.tldr, n.domains, n.kind
     FROM notes_fts f
     JOIN notes n ON n.rowid = f.rowid
     WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
       AND (n.kind IS NULL OR n.kind <> 'task')${priv}
     ORDER BY rank
     LIMIT ?`
  ).bind(safe, limit).all<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>();
  return r.results ?? [];
}

// Conta quantas notas de CONHECIMENTO (NON_TASK_FILTER — task NUNCA entra aqui)
// usam cada área. Usado pela seção "Áreas e tipos" de /app/config (spec 54) pra
// mostrar a contagem por linha. `domains` é JSON-encoded (array de slugs); sem
// índice pra DISTINCT no D1, agrega em memória — aceitável no volume do vault
// (mesma ordem de grandeza de handleGraphMeta, que já faz full scan de notes).
export async function listDomainCounts(env: Env): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT domains FROM notes WHERE deleted_at IS NULL AND ${NON_TASK_FILTER}`
  ).all<{ domains: string }>();
  const counts: Record<string, number> = {};
  for (const row of rows.results ?? []) {
    let arr: unknown;
    try { arr = JSON.parse(row.domains || '[]'); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const d of arr) {
      if (typeof d !== 'string' || !d) continue;
      counts[d] = (counts[d] ?? 0) + 1;
    }
  }
  return counts;
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
  // Estágio visual do Kanban (migration 0009). NULL = nunca alocado (render cai no
  // default da categoria do status). Ver resolveTaskColumn / SEED_COLUMN_BY_CATEGORY.
  column_id: string | null;
  // Projeto/pasta (migration 0011). NULL = "Sem projeto" (default). Single-valorado —
  // ortogonal a domains e tags. Ver TaskProject / spec 58.
  project_id: string | null;
  // Selo de privacidade (migration 0013, coluna compartilhada com notas). 0 = pública
  // (default), 1 = privada. Gate dos read paths de task via includePrivate (spec 59).
  // Opcional no tipo porque resolveShare (share.ts) faz um SELECT parcial sem a coluna.
  private?: number;
  created_at: number; updated_at: number;
  // Compartilhamento público read-only (migration 0008). share_token guarda o HASH
  // sha256 do token (nunca o plaintext); NULL = task não compartilhada. Opcionais no
  // tipo porque a maioria das queries de task (TASK_COLS) não os seleciona.
  share_token?: string | null;
  share_expires_at?: number | null;
}

export interface InsertTaskInput {
  id: string; title: string; body: string; tldr: string; domains: string;
  status: TaskStatus; due_at: number | null; priority: number | null;
  created_at: number; updated_at: number;
  // Aditivo: quando a task nasce fechada (done/canceled), stampar completed_at
  // preserva o invariante "fechada ⇒ completed_at preenchido" mantido por
  // setTaskStatus/updateTask/completeTask. Chamadores antigos passam null/omitem.
  completed_at?: number | null;
  // Estágio visual (migration 0009). Omitir/null → insertTask resolve a coluna
  // default da categoria do status. Ver spec 51.
  column_id?: string | null;
  // Projeto/pasta (migration 0011). Omitir/null → task nasce sem projeto. Ver spec 58.
  project_id?: string | null;
  // Selo de privacidade (spec 59): 1 = nasce privada. Omitir/0 = pública (default). O
  // save_task expõe isso como flag opcional; a UI/tool marcam via setTaskPrivate depois.
  private?: 0 | 1;
}

const TASK_COLS = `id, title, body, tldr, domains, kind, status, due_at, priority, completed_at, column_id, project_id, private, created_at, updated_at, share_token, share_expires_at`;

// Busca FTS restrita a TASKS — o espelho do ftsSearch, que as exclui. As linhas de
// task JÁ estão no notes_fts (os triggers da migration 0001 indexam TODAS as notas);
// aqui só se ABRE o caminho de leitura. Zero migration. Usa prefix=true (busca
// exploratória p/ dedupe por fragmento de título). Devolve TaskRow completo — o
// list_tasks precisa de status/due/priority pra montar o card. Ver spec 15 item 1.
export async function ftsSearchTasks(
  env: Env, query: string, limit: number, includePrivate = false
): Promise<TaskRow[]> {
  const safe = sanitizeFtsQuery(query, true);
  if (!safe) return [];
  const cols = TASK_COLS.split(', ').map((c) => `n.${c}`).join(', ');
  // Selo de privacidade (spec 59): default false appenda `AND n.private = 0` — o caminho
  // FTS de task (usado por list_tasks?query) não pode vazar task privada pra caller sem escopo.
  const priv = includePrivate ? '' : ` AND n.${PUBLIC_ONLY_FILTER}`;
  const r = await env.DB.prepare(
    `SELECT ${cols}
     FROM notes_fts f
     JOIN notes n ON n.rowid = f.rowid
     WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND n.kind = 'task'${priv}
     ORDER BY rank
     LIMIT ?`
  ).bind(safe, limit).all<TaskRow>();
  return r.results ?? [];
}

// Insere uma task. NÃO embeda — diferente de insertNote, que é seguido por
// upsertNoteVector no save_note. Aqui não há vetor de propósito. Aloca a coluna
// default da categoria do status quando `column_id` não vier explícito (spec 51),
// pra a task já nascer coerente com o Kanban.
export async function insertTask(env: Env, t: InsertTaskInput, actor?: string | null): Promise<void> {
  let columnId = t.column_id ?? null;
  if (columnId === null) {
    const col = await defaultColumnForCategory(env, t.status);
    columnId = col?.id ?? null;
  }
  // `actor` (spec 17): autoria da escrita — mesma semântica de insertNote (tasks
  // moram na tabela notes). Ausente → NULL. `private` (spec 59): default 0 (pública).
  await env.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,column_id,project_id,private,created_by,updated_by,created_at,updated_at)
     VALUES (?,?,?,?,?,'task',?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(t.id, t.title, t.body, t.tldr, t.domains, t.status, t.due_at, t.priority, t.completed_at ?? null, columnId, t.project_id ?? null, t.private ?? 0, actor ?? null, actor ?? null, t.created_at, t.updated_at).run();
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
// tasks ativas via FTS5 MATCH (mesmo índice/sanitização do ftsSearch*) em vez de
// `title LIKE '%...%'`: um pattern LIKE cresce com o tamanho do título e o D1
// rejeita patterns longos com "LIKE or GLOB pattern too complex" (SQLITE_ERROR) —
// títulos curtos passavam, títulos longos/pontuados (que geram mais tokens, não
// o comprimento em si — a pontuação é sempre stripada pelo sanitizeFtsQuery)
// derrubavam o save_task inteiro. FTS5 MATCH não tem esse teto de comprimento.
// sanitizeFtsQuery(prefix=true) já neutraliza AND/OR/NOT/NEAR e pontuação
// (':','(',')','—' etc. nunca chegam à query). Sem título com token válido
// (ex.: title só com pontuação), devolve [] sem tocar o banco.
export async function findSimilarActiveTasksByTitle(
  env: Env, title: string
): Promise<Array<Pick<TaskRow,'id'|'title'|'status'|'due_at'>>> {
  const safe = sanitizeFtsQuery(title, true);
  if (!safe) return [];
  const r = await env.DB.prepare(
    `SELECT n.id, n.title, n.status, n.due_at
     FROM notes_fts f
     JOIN notes n ON n.rowid = f.rowid
     WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
       AND n.kind = 'task' AND n.status IN ('open','in_progress')
     ORDER BY rank
     LIMIT 5`
  ).bind(safe).all<Pick<TaskRow,'id'|'title'|'status'|'due_at'>>();
  return r.results ?? [];
}

// Selo de privacidade (spec 59): includePrivate default false appenda `AND private = 0`,
// então uma credencial sem escopo `private` recebe null numa task privada (indistinguível
// de inexistente — get_task devolve o MESMO erro de "not found"). A sessão do dono, o
// bearer de tasks e os read-backs internos de escrita (complete/update/move) passam true.
export async function getTaskById(env: Env, id: string, includePrivate = false): Promise<TaskRow | null> {
  const priv = includePrivate ? '' : ` AND ${PUBLIC_ONLY_FILTER}`;
  return env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes WHERE id = ? AND kind = 'task' AND deleted_at IS NULL${priv}`
  ).bind(id).first<TaskRow>();
}

// Tasks ativas (open + in_progress), ordenadas por vencimento (sem due primeiro? não:
// NULLs por último), depois prioridade (1 = mais alta). Usado pela coluna esquerda do
// Kanban e como base das outras visões.
export async function listActiveTasks(env: Env, includePrivate = false): Promise<TaskRow[]> {
  // Selo de privacidade (spec 59): default false esconde task privada; board web e
  // bearer de tasks (superfícies do dono) passam true.
  const priv = includePrivate ? '' : ` AND ${PUBLIC_ONLY_FILTER}`;
  const r = await env.DB.prepare(
    // LIMIT 500 defensivo = teto do `limit` da tool list_tasks; evita puxar milhares
    // de tasks abertas num vault que cresceu (o slice da tool já corta, mas o SQL não
    // deve materializar tudo). Ver spec 15 item 8.
    `SELECT ${TASK_COLS} FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND status IN ('open','in_progress')${priv}
     ORDER BY (due_at IS NULL) ASC, due_at ASC, COALESCE(priority, 9) ASC, created_at ASC
     LIMIT 500`
  ).all<TaskRow>();
  return r.results ?? [];
}

// Tasks finalizadas (done/canceled) mais recentes — limitadas pra a coluna direita
// do Kanban não crescer pra sempre conforme o histórico acumula.
export async function listRecentClosedTasks(env: Env, limit = 100, includePrivate = false): Promise<TaskRow[]> {
  // Selo de privacidade (spec 59): default false esconde task privada fechada.
  const priv = includePrivate ? '' : ` AND ${PUBLIC_ONLY_FILTER}`;
  const r = await env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND status IN ('done','canceled')${priv}
     ORDER BY COALESCE(completed_at, updated_at) DESC
     LIMIT ?`
  ).bind(limit).all<TaskRow>();
  return r.results ?? [];
}

// Tasks que vencem até `beforeMs` (inclui as já vencidas, pois due_at < now < beforeMs).
// Só conta tasks com due_at definido e ainda abertas. Ordenadas por vencimento +
// prioridade. Base do list_tasks_due_today e do lembrete da VPS.
export async function listTasksDueBefore(env: Env, beforeMs: number, includePrivate = false): Promise<TaskRow[]> {
  // Selo de privacidade (spec 59): default false esconde task privada. O digest do dono
  // (cron/bearer) e a visão "due" do board passam true; o list_tasks_due_today MCP passa
  // canSeePrivate do PAT.
  const priv = includePrivate ? '' : ` AND ${PUBLIC_ONLY_FILTER}`;
  const r = await env.DB.prepare(
    `SELECT ${TASK_COLS} FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL
       AND status IN ('open','in_progress')
       AND due_at IS NOT NULL AND due_at <= ?${priv}
     ORDER BY due_at ASC, COALESCE(priority, 9) ASC`
  ).bind(beforeMs).all<TaskRow>();
  return r.results ?? [];
}

// Muda o status de uma task. Ao marcar done/canceled grava completed_at=now; ao
// reabrir (open/in_progress) limpa completed_at. Realoca column_id pra coluna default
// da nova categoria (mantém o invariante category(column_id)==status). Retorna false
// se o id não é uma task.
export async function setTaskStatus(env: Env, id: string, status: TaskStatus, now: number): Promise<boolean> {
  const closing = status === 'done' || status === 'canceled';
  const col = await defaultColumnForCategory(env, status);
  const columnId = col?.id ?? null;
  const res = await env.DB.prepare(
    `UPDATE notes SET status = ?, column_id = ?, completed_at = ${closing ? '?' : 'NULL'}, updated_at = ?
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(...(closing ? [status, columnId, now, now, id] : [status, columnId, now, id])).run();
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
  env: Env, id: string, now: number, outcome?: string, expectedUpdatedAt?: number, actor?: string | null
): Promise<CompleteResult> {
  // includePrivate=true: concluir é operação de escrita do dono — precisa enxergar
  // task privada (o gate de leitura da spec 59 é nos read paths, não no write).
  const before = await getTaskById(env, id, true);
  if (!before) return 'not-found';
  // Idempotência: já concluída → no-op (não re-appenda o body, não avança timestamps).
  if (before.status === 'done') return 'already-done';
  // Versionamento otimista opt-in: se o cliente informou o updated_at que leu e a
  // task mudou desde então, não escrever.
  if (expectedUpdatedAt !== undefined && before.updated_at !== expectedUpdatedAt) {
    return 'conflict';
  }

  const trimmed = outcome && outcome.trim() ? outcome.trim() : null;
  // Realoca pra coluna default de 'done' (mantém invariante category==status).
  const doneCol = await defaultColumnForCategory(env, 'done');
  const doneColId = doneCol?.id ?? null;
  const res = await env.DB.prepare(
    `UPDATE notes
     SET status = 'done',
         column_id = ?,
         completed_at = ?,
         updated_at = ?,
         updated_by = COALESCE(?, updated_by),
         body = CASE WHEN ? IS NULL THEN body
                     ELSE body || char(10) || char(10) || '**Resultado:** ' || ? END
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL
       AND status <> 'done'
       AND (? IS NULL OR updated_at = ?)`
  ).bind(doneColId, now, now, actor ?? null, trimmed, trimmed, id, expectedUpdatedAt ?? null, expectedUpdatedAt ?? null).run();

  if ((res.meta?.changes ?? 0) === 0) {
    // Alguém venceu a corrida ou a versão não bateu. Reler pra decidir o sentinel.
    const after = await getTaskById(env, id, true);
    if (!after) return 'not-found';
    if (after.status === 'done') return 'already-done';
    return 'conflict';
  }

  const after = await getTaskById(env, id, true);
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
  // Substitui TODAS as tags ([] limpa as não-reservadas). Reservadas dedupe:*
  // são preservadas automaticamente por replaceTaskTagsPreservingDedupe — ver ali.
  tags?: string[];
  // Projeto/pasta (spec 58). id de projeto pra vincular, ou null pra DESvincular
  // ("Sem projeto"). Omitir mantém. A resolução de label→id/auto-create acontece
  // ANTES (nas tools/endpoints); aqui só grava o id (ou null) já resolvido.
  project_id?: string | null;
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
  env: Env, id: string, patch: TaskPatch, now: number, expectedUpdatedAt?: number, actor?: string | null
): Promise<UpdateResult> {
  // includePrivate=true: editar é operação de escrita — enxerga task privada (o gate
  // da spec 59 é de leitura). A visibilidade por escopo, quando aplicável, é decidida
  // na tool/endpoint antes de chamar aqui.
  const task = await getTaskById(env, id, true);
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
  if (patch.project_id !== undefined) { sets.push('project_id = ?'); binds.push(patch.project_id); }
  if (patch.domains !== undefined) { sets.push('domains = ?'); binds.push(patch.domains); }
  if (patch.status !== undefined) {
    const closing = patch.status === 'done' || patch.status === 'canceled';
    sets.push('status = ?'); binds.push(patch.status);
    // Realoca column_id pra coluna default da nova categoria (invariante
    // category(column_id)==status). Mudança de status por MCP/UI reflete no board.
    const col = await defaultColumnForCategory(env, patch.status);
    sets.push('column_id = ?'); binds.push(col?.id ?? null);
    sets.push(`completed_at = ${closing ? '?' : 'NULL'}`);
    if (closing) binds.push(now);
  }
  sets.push('updated_at = ?'); binds.push(now);
  // Autoria (spec 17): COALESCE mantém o updated_by anterior quando não há actor.
  sets.push('updated_by = COALESCE(?, updated_by)'); binds.push(actor ?? null);

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

  // Tags vivem em tabela própria (fora do UPDATE de `notes` acima) — só mexe se o
  // patch trouxer a chave. Aplicado DEPOIS da checagem de conflito: uma escrita
  // rejeitada por versão não deve tocar tags.
  if (patch.tags !== undefined) {
    await replaceTaskTagsPreservingDedupe(env, id, patch.tags);
  }

  const after = await getTaskById(env, id, true);
  return after ?? 'not-found';
}

// ─────────────────────────── KANBAN COLUMNS ───────────────────────────
// CRUD + resolução de coluna. Ver spec 51 e a migration 0009.

// Lista colunas. Por padrão só as ATIVAS (archived_at IS NULL), ordenadas por
// position. includeArchived=true traz também as arquivadas (usado pela UI de config).
export async function listKanbanColumns(env: Env, includeArchived = false): Promise<KanbanColumn[]> {
  const sql = includeArchived
    ? `SELECT id, label, color, position, category, archived_at FROM kanban_columns ORDER BY position ASC`
    : `SELECT id, label, color, position, category, archived_at FROM kanban_columns WHERE archived_at IS NULL ORDER BY position ASC`;
  const r = await env.DB.prepare(sql).all<KanbanColumn>();
  return r.results ?? [];
}

export async function getColumnById(env: Env, id: string): Promise<KanbanColumn | null> {
  return env.DB.prepare(
    `SELECT id, label, color, position, category, archived_at FROM kanban_columns WHERE id = ?`
  ).bind(id).first<KanbanColumn>();
}

// Coluna default de uma categoria: a ATIVA de menor position. Se não houver ativa,
// cai no seed fixo da categoria MESMO arquivado (nunca devolve null pras 4 categorias
// canônicas num banco provisionado) — garante que uma escrita sempre resolve um
// column_id coerente. Ver SEED_COLUMN_BY_CATEGORY.
export async function defaultColumnForCategory(env: Env, category: TaskStatus): Promise<KanbanColumn | null> {
  const active = await env.DB.prepare(
    `SELECT id, label, color, position, category, archived_at FROM kanban_columns
     WHERE category = ? AND archived_at IS NULL
     ORDER BY position ASC LIMIT 1`
  ).bind(category).first<KanbanColumn>();
  if (active) return active;
  const seedId = SEED_COLUMN_BY_CATEGORY[category];
  return seedId ? getColumnById(env, seedId) : null;
}

// Resolve a coluna de UMA task a partir de um conjunto já carregado de colunas
// (puro, sem env) — evita N queries no list_tasks e centraliza a regra:
//   1) coluna atribuída (mesmo arquivada) se o column_id existe;
//   2) senão, a ativa de menor position da categoria do status;
//   3) senão, o seed da categoria (mesmo arquivado).
// Devolve null só se o conjunto não tiver NENHUMA coluna da categoria (banco não
// provisionado) — o caller então cai no status cru.
export function resolveTaskColumn(
  task: { column_id?: string | null; status: string | null },
  columns: KanbanColumn[]
): KanbanColumn | null {
  if (task.column_id) {
    const assigned = columns.find((c) => c.id === task.column_id);
    if (assigned) return assigned;
  }
  const cat = (task.status ?? 'open') as TaskStatus;
  const active = columns
    .filter((c) => c.category === cat && c.archived_at === null)
    .sort((a, b) => a.position - b.position);
  if (active.length > 0) return active[0];
  const seedId = SEED_COLUMN_BY_CATEGORY[cat];
  return columns.find((c) => c.id === seedId) ?? null;
}

export type MoveResult = TaskRow | 'not-found' | 'column-not-found';

// Move uma task pra uma coluna (drag & drop do board). Resolve a coluna, seta
// column_id E status = category da coluna, e completed_at quando a categoria fecha
// (done/canceled) ou limpa ao reabrir — tudo num único UPDATE atômico (mantém o
// invariante category(column_id)==status). Ver spec 51 item 2.
export async function moveTaskToColumn(env: Env, id: string, columnId: string, now: number): Promise<MoveResult> {
  const col = await getColumnById(env, columnId);
  if (!col) return 'column-not-found';
  const closing = col.category === 'done' || col.category === 'canceled';
  const res = await env.DB.prepare(
    `UPDATE notes SET column_id = ?, status = ?, completed_at = ${closing ? '?' : 'NULL'}, updated_at = ?
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(...(closing ? [columnId, col.category, now, now, id] : [columnId, col.category, now, id])).run();
  if ((res.meta?.changes ?? 0) === 0) return 'not-found';
  const after = await getTaskById(env, id, true);
  return after ?? 'not-found';
}

// Realoca em massa as tasks (vivas) de uma coluna pra outra (usado ao arquivar uma
// coluna com tasks). Só mexe em column_id — status não muda (destino é da MESMA
// categoria, validado no caller). Retorna quantas tasks foram movidas. NÃO usa
// res.meta.changes: os triggers de FTS em `notes` (notes_au) inflam o `changes` de
// um UPDATE em notes (escritas nas shadow tables do FTS5 contam junto), então o
// count vem de um count(*) antes do UPDATE (imune aos triggers).
export async function reassignColumn(env: Env, fromId: string, toId: string): Promise<number> {
  const n = await countTasksInColumn(env, fromId);
  if (n > 0) {
    await env.DB.prepare(
      `UPDATE notes SET column_id = ? WHERE kind = 'task' AND deleted_at IS NULL AND column_id = ?`
    ).bind(toId, fromId).run();
  }
  return n;
}

// Conta tasks (não deletadas) alocadas numa coluna — pra decidir se o arquivamento
// precisa de coluna destino.
export async function countTasksInColumn(env: Env, columnId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT count(*) AS c FROM notes WHERE kind = 'task' AND deleted_at IS NULL AND column_id = ?`
  ).bind(columnId).first<{ c: number }>();
  return r?.c ?? 0;
}

// Contagem de tasks por column_id numa query só (GROUP BY) — pra a UI de config
// mostrar quantas tasks cada coluna tem sem N+1.
export async function taskCountsByColumn(env: Env): Promise<Map<string, number>> {
  const r = await env.DB.prepare(
    `SELECT column_id, count(*) AS c FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND column_id IS NOT NULL
     GROUP BY column_id`
  ).all<{ column_id: string; c: number }>();
  const m = new Map<string, number>();
  for (const row of r.results ?? []) m.set(row.column_id, row.c);
  return m;
}

// Cria uma coluna nova. id = 'col_' + slug aleatório; position = max+1. archived_at
// nasce null (ativa). Retorna a coluna criada.
export async function createKanbanColumn(
  env: Env, input: { label: string; color: string | null; category: TaskStatus; id: string }
): Promise<KanbanColumn> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), 0) AS m FROM kanban_columns`
  ).first<{ m: number }>();
  const position = (row?.m ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO kanban_columns (id, label, color, position, category, archived_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).bind(input.id, input.label, input.color, position, input.category).run();
  return { id: input.id, label: input.label, color: input.color, position, category: input.category, archived_at: null };
}

// Edita label/color de uma coluna (categoria é TRAVADA após criação — mudá-la
// reclassificaria status em massa, fora de escopo). Retorna false se o id não existe.
export async function updateKanbanColumn(
  env: Env, id: string, patch: { label?: string; color?: string | null }
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.label !== undefined) { sets.push('label = ?'); binds.push(patch.label); }
  if (patch.color !== undefined) { sets.push('color = ?'); binds.push(patch.color); }
  if (sets.length === 0) return false;
  binds.push(id);
  const res = await env.DB.prepare(
    `UPDATE kanban_columns SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Reordena trocando a position da coluna com a vizinha na direção dada (↑/↓), no
// conjunto de colunas ATIVAS ordenado por position. Retorna false se não há vizinha
// (já é a primeira/última) ou o id não é uma coluna ativa.
export async function reorderKanbanColumn(env: Env, id: string, direction: 'up' | 'down'): Promise<boolean> {
  const cols = await listKanbanColumns(env, false); // ativas, ordenadas por position
  const idx = cols.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= cols.length) return false;
  const a = cols[idx];
  const b = cols[swapIdx];
  const upd = env.DB.prepare(`UPDATE kanban_columns SET position = ? WHERE id = ?`);
  await env.DB.batch([upd.bind(b.position, a.id), upd.bind(a.position, b.id)]);
  return true;
}

// Arquiva/desarquiva uma coluna. Só mexe em archived_at — a realocação de tasks
// (quando arquiva) fica a cargo do caller (endpoint), que valida a coluna destino.
export async function setColumnArchived(env: Env, id: string, archivedAt: number | null): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE kanban_columns SET archived_at = ? WHERE id = ?`
  ).bind(archivedAt, id).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Quantas colunas ATIVAS existem numa categoria (pra impedir arquivar a última
// coluna ativa de open/done — senão as tasks dessas categorias sumiriam do board).
export async function countActiveColumnsInCategory(env: Env, category: TaskStatus): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT count(*) AS c FROM kanban_columns WHERE category = ? AND archived_at IS NULL`
  ).bind(category).first<{ c: number }>();
  return r?.c ?? 0;
}

// ─────────────────────────── TASK COMMENTS ───────────────────────────
// Thread de comentários por task (migration 0010). 3 autores: 'owner' (console do
// dono), 'agent' (MCP) e 'guest' (página pública /s/<token>). Tabela PRÓPRIA — o
// comentário não é nota, não embeda, não entra no grafo/recall. Ver spec 53.
export type CommentAuthor = 'owner' | 'guest' | 'agent';

export interface TaskComment {
  id: string;
  task_id: string;
  author: CommentAuthor;
  author_name: string | null;
  body: string;
  created_at: number;
}

// Insere um comentário. O caller valida ANTES que a task existe e está viva
// (getTaskById no console/agent; resolveShare no público) — aqui só grava. O
// author_name já chega trimado/limitado pelo caller (guest exige nome; owner/agent
// podem ser null). O CHECK de length(body) na migration é a última linha de defesa.
export async function addTaskComment(env: Env, c: TaskComment): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO task_comments (id, task_id, author, author_name, body, created_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(c.id, c.task_id, c.author, c.author_name, c.body, c.created_at).run();
}

// Lista os comentários de UMA task em ordem cronológica. O JOIN em notes com
// deleted_at IS NULL garante que comentário de task SOFT-deletada não vaza (o
// soft-delete não cascateia a FK). limit/offset pra paginação.
export async function listTaskComments(
  env: Env, taskId: string, limit = 200, offset = 0
): Promise<TaskComment[]> {
  const r = await env.DB.prepare(
    `SELECT c.id, c.task_id, c.author, c.author_name, c.body, c.created_at
     FROM task_comments c
     JOIN notes n ON n.id = c.task_id
     WHERE c.task_id = ? AND n.deleted_at IS NULL AND n.kind = 'task'
     ORDER BY c.created_at ASC, c.id ASC
     LIMIT ? OFFSET ?`
  ).bind(taskId, limit, offset).all<TaskComment>();
  return r.results ?? [];
}

// Conta comentários de UMA task, opcionalmente filtrando por autor (o filtro de
// autor alimenta o teto absoluto de guest — spec 53, riscos). Mesma defesa do
// listTaskComments: só conta comentário de task viva.
export async function countTaskComments(
  env: Env, taskId: string, author?: CommentAuthor
): Promise<number> {
  const base =
    `SELECT count(*) AS c FROM task_comments c
     JOIN notes n ON n.id = c.task_id
     WHERE c.task_id = ? AND n.deleted_at IS NULL AND n.kind = 'task'`;
  const stmt = author
    ? env.DB.prepare(`${base} AND c.author = ?`).bind(taskId, author)
    : env.DB.prepare(base).bind(taskId);
  const row = await stmt.first<{ c: number }>();
  return row?.c ?? 0;
}

// Contagem de comentários por task numa query só (GROUP BY, chunked p/ não estourar
// binds do D1) — pro payload do board sem N+1. Recebe ids de tasks já vivas (o board
// só carrega tasks não-deletadas), então dispensa o JOIN: conta os comentários dos
// ids dados. Retorna Map id→count (ausente = 0 comentários).
export async function countTaskCommentsBatch(
  env: Env, taskIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (taskIds.length === 0) return out;
  for (let i = 0; i < taskIds.length; i += 100) {
    const chunk = taskIds.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT task_id, count(*) AS c FROM task_comments
       WHERE task_id IN (${ph})
       GROUP BY task_id`
    ).bind(...chunk).all<{ task_id: string; c: number }>();
    for (const row of r.results ?? []) out.set(row.task_id, row.c);
  }
  return out;
}

// Apaga UM comentário por id (hard delete — moderação do dono pelo console). Retorna
// true se removeu. NÃO filtra por autor de propósito: o dono pode apagar qualquer
// comentário, inclusive de convidado. O endpoint que chama já exige sessão do dono.
export async function deleteTaskComment(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM task_comments WHERE id = ?`).bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ─────────────────────────── TASK PROJECTS ───────────────────────────
// Projetos/pastas de task (migration 0011). Eixo de agrupamento single-valorado,
// ORTOGONAL a domains e tags. Tabela PRÓPRIA — projeto não é nota, não embeda, não
// entra no grafo/recall. Ver spec 58.
export const TASK_PROJECT_CAP = 64;

export interface TaskProject {
  id: string;
  label: string;
  color: string | null;      // hex #rrggbb; null = neutro do tema
  position: number;
  archived_at: number | null; // arquivado some dos selects/filtros default (histórico consultável)
  created_at: number;
}

// Lista projetos. Por padrão só ATIVOS (archived_at IS NULL), ordenados por position.
// includeArchived=true traz também os arquivados (usado pela UI de config e pela
// resolução de filtro do board, que lista histórico).
export async function listTaskProjects(env: Env, includeArchived = false): Promise<TaskProject[]> {
  const sql = includeArchived
    ? `SELECT id, label, color, position, archived_at, created_at FROM task_projects ORDER BY position ASC`
    : `SELECT id, label, color, position, archived_at, created_at FROM task_projects WHERE archived_at IS NULL ORDER BY position ASC`;
  const r = await env.DB.prepare(sql).all<TaskProject>();
  return r.results ?? [];
}

export async function getProjectById(env: Env, id: string): Promise<TaskProject | null> {
  return env.DB.prepare(
    `SELECT id, label, color, position, archived_at, created_at FROM task_projects WHERE id = ?`
  ).bind(id).first<TaskProject>();
}

// Resolve um projeto por id EXATO ou por label (case-insensitive Unicode, trim). O
// match é feito em JS sobre o conjunto de projetos (cap 64 → carregar tudo é barato) —
// SQLite lower() só cobre ASCII, e labels podem ter acento ("Pessoal", "Educação").
// activesOnly=true restringe aos ativos (usado pela escrita: só vincula a projeto
// ativo); false varre ativos + arquivados (usado pelo filtro do board — histórico).
export async function getProjectByIdOrLabel(
  env: Env, ref: string, activesOnly: boolean
): Promise<TaskProject | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const all = await listTaskProjects(env, true);
  const pool = activesOnly ? all.filter((p) => p.archived_at === null) : all;
  const byId = pool.find((p) => p.id === trimmed);
  if (byId) return byId;
  const wanted = trimmed.toLowerCase();
  return pool.find((p) => p.label.trim().toLowerCase() === wanted) ?? null;
}

// Conta TODOS os projetos (ativos + arquivados) — base do cap de 64 (criar via UI e
// auto-create do MCP).
export async function countTaskProjects(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT count(*) AS c FROM task_projects`).first<{ c: number }>();
  return r?.c ?? 0;
}

// Cria um projeto novo. position = max+1 (entra no fim). archived_at nasce null.
// O caller já validou o cap (countTaskProjects < TASK_PROJECT_CAP) e gerou o id
// ('proj_' + rand8). Retorna o projeto criado.
export async function createTaskProject(
  env: Env, input: { id: string; label: string; color: string | null }, now: number
): Promise<TaskProject> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), 0) AS m FROM task_projects`
  ).first<{ m: number }>();
  const position = (row?.m ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO task_projects (id, label, color, position, archived_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  ).bind(input.id, input.label, input.color, position, now).run();
  return { id: input.id, label: input.label, color: input.color, position, archived_at: null, created_at: now };
}

// Edita label/color de um projeto. Retorna false se o id não existe.
export async function updateTaskProject(
  env: Env, id: string, patch: { label?: string; color?: string | null }
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.label !== undefined) { sets.push('label = ?'); binds.push(patch.label); }
  if (patch.color !== undefined) { sets.push('color = ?'); binds.push(patch.color); }
  if (sets.length === 0) return false;
  binds.push(id);
  const res = await env.DB.prepare(
    `UPDATE task_projects SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Reordena trocando a position com a vizinha na direção dada (↑/↓), no conjunto de
// projetos ATIVOS ordenado por position. Retorna false se não há vizinha (já é a
// primeira/última) ou o id não é um projeto ativo.
export async function reorderTaskProject(env: Env, id: string, direction: 'up' | 'down'): Promise<boolean> {
  const list = await listTaskProjects(env, false); // ativos, ordenados por position
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return false;
  const a = list[idx];
  const b = list[swapIdx];
  const upd = env.DB.prepare(`UPDATE task_projects SET position = ? WHERE id = ?`);
  await env.DB.batch([upd.bind(b.position, a.id), upd.bind(a.position, b.id)]);
  return true;
}

// Arquiva/desarquiva um projeto. Só mexe em archived_at — as tasks NÃO são realocadas
// (project_id fica; o chip renderiza esmaecido). Retorna false se o id não existe.
export async function setProjectArchived(env: Env, id: string, archivedAt: number | null): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE task_projects SET archived_at = ? WHERE id = ?`
  ).bind(archivedAt, id).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Conta tasks (vivas) de UM projeto — pra a UI de config mostrar o tamanho de cada
// pasta e pra decidir realocação (não há: arquivar mantém as tasks).
export async function countTasksByProject(env: Env, projectId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT count(*) AS c FROM notes WHERE kind = 'task' AND deleted_at IS NULL AND project_id = ?`
  ).bind(projectId).first<{ c: number }>();
  return r?.c ?? 0;
}

// Contagem de tasks por project_id numa query só (GROUP BY) — pra a UI de config
// mostrar o tamanho de cada pasta sem N+1.
export async function taskCountsByProject(env: Env): Promise<Map<string, number>> {
  const r = await env.DB.prepare(
    `SELECT project_id, count(*) AS c FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND project_id IS NOT NULL
     GROUP BY project_id`
  ).all<{ project_id: string; c: number }>();
  const m = new Map<string, number>();
  for (const row of r.results ?? []) m.set(row.project_id, row.c);
  return m;
}

// ─────────────────────────── INBOX DE CAPTURA (spec 63) ───────────────────────────
// Captura sem fricção: TUDO entra cru em `inbox_items` (migration 0014) e é triado
// depois. Tabela PRÓPRIA (não é nota) — um rascunho NÃO embeda, NÃO entra em
// recall/FTS/grafo/stats: fica invisível pra esses read paths POR CONSTRUÇÃO (zero
// filtro por superfície). A triagem (resolve) só MARCA o desfecho; quem cria a
// nota/task é o fluxo normal (save_note/save_task ou os endpoints do console).

// Teto do corpo cru capturado (validado nas 3 entradas: tool capture, quick-add web,
// e a spec fala em "≤4000 chars"). Constante única pra tool e web não divergirem.
export const INBOX_BODY_MAX = 4000;

// Ações de triagem possíveis (resolve_inbox). 'discard' NÃO apaga a linha (descarte é
// barato e o item fica auditável); só marca triaged_at + triage_action.
export const INBOX_ACTIONS = ['note', 'task', 'discard'] as const;
export type InboxAction = typeof INBOX_ACTIONS[number];

export interface InboxItem {
  id: string;
  body: string;
  source: string;             // mcp | console | telegram | whatsapp (string livre informativa)
  created_at: number;
  triaged_at: number | null;  // NULL = pendente
  triage_action: string | null;
  result_id: string | null;
}

export async function insertInboxItem(
  env: Env, item: { id: string; body: string; source: string; created_at: number }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO inbox_items (id, body, source, created_at) VALUES (?, ?, ?, ?)`
  ).bind(item.id, item.body, item.source, item.created_at).run();
}

// Lista itens do inbox. pendingOnly=true (default) usa o índice parcial idx_inbox_pending.
// Ordem: created_at ASC (mais antigo primeiro) — ordem natural de triagem GTD (processa
// o que está apodrecendo antes). Desempate determinístico por id.
export async function listInboxItems(
  env: Env, opts: { pendingOnly?: boolean; limit?: number } = {}
): Promise<InboxItem[]> {
  const pendingOnly = opts.pendingOnly ?? true;
  const limit = opts.limit ?? 200;
  const where = pendingOnly ? 'WHERE triaged_at IS NULL' : '';
  const r = await env.DB.prepare(
    `SELECT id, body, source, created_at, triaged_at, triage_action, result_id
     FROM inbox_items ${where}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`
  ).bind(limit).all<InboxItem>();
  return r.results ?? [];
}

export async function getInboxItem(env: Env, id: string): Promise<InboxItem | null> {
  return env.DB.prepare(
    `SELECT id, body, source, created_at, triaged_at, triage_action, result_id
     FROM inbox_items WHERE id = ?`
  ).bind(id).first<InboxItem>();
}

// Marca um item como triado. Idempotente e seguro contra corrida: o UPDATE só toca a
// linha AINDA pendente (triaged_at IS NULL), então uma segunda triagem não sobrescreve
// a primeira. Retorna:
//   { ok: true,  alreadyTriaged: false } — triado agora
//   { ok: false, alreadyTriaged: true  } — já estava triado (no-op)
//   { ok: false, alreadyTriaged: false } — id inexistente
export async function resolveInboxItem(
  env: Env, id: string, action: InboxAction, resultId: string | null, triagedAt: number
): Promise<{ ok: boolean; alreadyTriaged: boolean }> {
  const res = await env.DB.prepare(
    `UPDATE inbox_items SET triaged_at = ?, triage_action = ?, result_id = ?
     WHERE id = ? AND triaged_at IS NULL`
  ).bind(triagedAt, action, resultId, id).run();
  if ((res.meta?.changes ?? 0) > 0) return { ok: true, alreadyTriaged: false };
  const existing = await getInboxItem(env, id);
  return { ok: false, alreadyTriaged: existing !== null };
}

// Contagem de pendentes (badge da navegação + retorno das tools). Usa o índice parcial.
export async function countPendingInbox(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT count(*) AS c FROM inbox_items WHERE triaged_at IS NULL`
  ).first<{ c: number }>();
  return r?.c ?? 0;
}
