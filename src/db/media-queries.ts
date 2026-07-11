import type { Env } from '../env.js';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaRow {
  id: string;
  note_id: string;
  kind: string;
  r2_key: string;
  content_hash: string;
  mime_type: string;
  size_bytes: number;
  original_filename: string | null;
  created_at: number;
}

export interface InsertMediaInput {
  id: string;
  note_id: string;
  kind: MediaKind;
  r2_key: string;
  content_hash: string;
  mime_type: string;
  size_bytes: number;
  original_filename: string | null;
  created_at: number;
}

const MEDIA_COLS = `id, note_id, kind, r2_key, content_hash, mime_type, size_bytes, original_filename, created_at`;

export async function insertMedia(env: Env, m: InsertMediaInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO note_media (${MEDIA_COLS}) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    m.id, m.note_id, m.kind, m.r2_key, m.content_hash, m.mime_type,
    m.size_bytes, m.original_filename, m.created_at,
  ).run();
}

export async function getMediaById(env: Env, id: string): Promise<MediaRow | null> {
  return env.DB.prepare(`SELECT ${MEDIA_COLS} FROM note_media WHERE id = ?`).bind(id).first<MediaRow>();
}

export async function listMediaByNote(env: Env, noteId: string): Promise<MediaRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${MEDIA_COLS} FROM note_media WHERE note_id = ? ORDER BY created_at ASC`
  ).bind(noteId).all<MediaRow>();
  return r.results ?? [];
}

export async function deleteMediaById(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM note_media WHERE id = ?`).bind(id).run();
}

// Quantas linhas note_media ainda apontam pra este content_hash. Usado no delete
// pra decidir se o blob R2 pode ser removido (só se for a ÚLTIMA referência — dedup).
export async function countMediaByHash(env: Env, contentHash: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT count(*) c FROM note_media WHERE content_hash = ?`
  ).bind(contentHash).first<{ c: number }>();
  return r?.c ?? 0;
}

// ───────────────────── MÍDIA DO INBOX (migration 0025, spec 68) ─────────────────────
// Espelho enxuto de note_media pro rascunho de captura: mesma key R2 (sha256/<hash>),
// dedup cross-tabela por construção. `item_id` referencia inbox_items.

export interface InboxMediaRow {
  id: string;
  item_id: string;
  kind: string;
  r2_key: string;
  content_hash: string;
  mime_type: string;
  size_bytes: number;
  original_filename: string | null;
  created_at: number;
}

const INBOX_MEDIA_COLS = `id, item_id, kind, r2_key, content_hash, mime_type, size_bytes, original_filename, created_at`;

export async function insertInboxMedia(env: Env, m: InboxMediaRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO inbox_media (${INBOX_MEDIA_COLS}) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    m.id, m.item_id, m.kind, m.r2_key, m.content_hash, m.mime_type,
    m.size_bytes, m.original_filename, m.created_at,
  ).run();
}

export async function getInboxMediaById(env: Env, id: string): Promise<InboxMediaRow | null> {
  return env.DB.prepare(`SELECT ${INBOX_MEDIA_COLS} FROM inbox_media WHERE id = ?`).bind(id).first<InboxMediaRow>();
}

export async function listInboxMediaByItem(env: Env, itemId: string): Promise<InboxMediaRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${INBOX_MEDIA_COLS} FROM inbox_media WHERE item_id = ? ORDER BY created_at ASC`
  ).bind(itemId).all<InboxMediaRow>();
  return r.results ?? [];
}

// Mídias de VÁRIOS itens numa query só (render da lista do inbox). Retorna Map por item.
export async function listInboxMediaByItems(env: Env, itemIds: string[]): Promise<Map<string, InboxMediaRow[]>> {
  const out = new Map<string, InboxMediaRow[]>();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT ${INBOX_MEDIA_COLS} FROM inbox_media WHERE item_id IN (${placeholders}) ORDER BY created_at ASC`
  ).bind(...itemIds).all<InboxMediaRow>();
  for (const row of r.results ?? []) {
    const arr = out.get(row.item_id) ?? [];
    arr.push(row);
    out.set(row.item_id, arr);
  }
  return out;
}

export async function deleteInboxMediaById(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM inbox_media WHERE id = ?`).bind(id).run();
}

// Refcount cross-tabela de um content_hash (note_media + inbox_media). Decide se o
// blob R2 pode ser removido quando uma referência sai de QUALQUER uma das tabelas.
export async function countMediaByHashAllTables(env: Env, contentHash: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM note_media WHERE content_hash = ?1)
          + (SELECT count(*) FROM inbox_media WHERE content_hash = ?1) AS c`
  ).bind(contentHash).first<{ c: number }>();
  return r?.c ?? 0;
}
