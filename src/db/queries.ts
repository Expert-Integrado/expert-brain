import type { Env } from '../env.js';

export const EDGE_TYPES = [
  'analogous_to','same_mechanism_as','instance_of','generalizes',
  'causes','depends_on','contradicts','evidence_for','refines',
] as const;
export type EdgeType = typeof EDGE_TYPES[number];

export const NOTE_KINDS = [
  'concept','decision','insight','fact',
  'pattern','principle','question',
] as const;
export type NoteKind = typeof NOTE_KINDS[number];

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
     ORDER BY rank
     LIMIT ?`
  ).bind(safe, limit).all<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>();
  return r.results ?? [];
}
