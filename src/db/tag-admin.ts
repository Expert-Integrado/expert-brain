import type { Env } from '../env.js';

// Gestão global de tags (pedido 10/07): a tabela tags é (note_id, tag) sem entidade
// própria — "renomear" e "apagar" são operações em massa sobre as linhas. Usado só
// pela seção Tags de /app/config; MCP/board continuam criando tags livremente via
// insertTags (vocabulário aberto de propósito).

export interface TagUsage { tag: string; count: number }

// Vocabulário visível: exclui as reservadas dedupe:* (infra de deduplicação, nunca
// aparecem em UI) e tags cujas notas foram soft-deletadas (não contam como uso).
export async function listAllTags(env: Env): Promise<TagUsage[]> {
  const r = await env.DB.prepare(
    `SELECT t.tag AS tag, COUNT(*) AS count
     FROM tags t JOIN notes n ON n.id = t.note_id
     WHERE n.deleted_at IS NULL AND t.tag NOT LIKE 'dedupe:%'
     GROUP BY t.tag
     ORDER BY t.tag COLLATE NOCASE`
  ).all<TagUsage>();
  return r.results ?? [];
}

// Renomeia em massa. Merge-safe: nota que JÁ tem a tag destino perde a linha antiga
// (senão o UPDATE violaria a PK (note_id, tag)). Retorna quantas notas ficaram com
// a tag nova (ou null se a origem não existe). Destino passa pela mesma normalização
// do insertTags (trim+lowercase — queries.ts normalizeTags).
export async function renameTag(env: Env, from: string, to: string): Promise<number | null> {
  const src = from.trim().toLowerCase();
  const dst = to.trim().toLowerCase();
  if (!src || !dst || dst.startsWith('dedupe:')) return null;
  const exists = await env.DB.prepare(`SELECT 1 FROM tags WHERE tag = ? LIMIT 1`).bind(src).first();
  if (!exists) return null;
  if (src !== dst) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM tags WHERE tag = ? AND note_id IN (SELECT note_id FROM tags WHERE tag = ?)`
      ).bind(src, dst),
      env.DB.prepare(`UPDATE tags SET tag = ? WHERE tag = ?`).bind(dst, src),
    ]);
  }
  const n = await env.DB.prepare(`SELECT COUNT(*) AS c FROM tags WHERE tag = ?`).bind(dst).first<{ c: number }>();
  return n?.c ?? 0;
}

// Apaga a tag de TODAS as notas (inclusive soft-deletadas — restaurar uma nota não
// pode ressuscitar uma tag que o dono removeu do vocabulário). Retorna linhas removidas.
export async function deleteTag(env: Env, tag: string): Promise<number> {
  const t = tag.trim().toLowerCase();
  if (!t) return 0;
  const r = await env.DB.prepare(`DELETE FROM tags WHERE tag = ?`).bind(t).run();
  return r.meta.changes ?? 0;
}
