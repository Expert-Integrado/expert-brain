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
