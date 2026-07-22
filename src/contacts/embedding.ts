// Helpers de embedding/Vectorize — fonte ÚNICA consumida por index.ts (REST/MCP)
// e por src/web/entity-update.ts (Console). Extraído de index.ts pra que o endpoint
// de sessão reindexe com EXATAMENTE a mesma lógica (texto canônico + metadata),
// sem importar do entrypoint (evita ciclo com o default export do Worker).

import type { Env } from "./env";

// Teto de chars do bloco de identidade (name/role/company/...) e teto TOTAL do texto
// de embedding (identidade + observações). bge-m3 aceita ~8k tokens — 3000 chars é
// conservador e dobra o sinal disponível vs. o teto antigo (spec 50-console-v2/60 §1).
const IDENTITY_MAX = 1500;
const EMBEDDING_TEXT_MAX = 3000;

// Texto canônico pra embedding — cobre campos de pessoa E empresa, mais o bloco
// opcional de OBSERVAÇÕES datadas (events kind='note', montadas por observationsTextFor).
//
// O NOME fica FORA do vetor (10/07/2026, pedido do dono): com o nome abrindo o texto,
// entidade só-nome virava "Similar" por grafia (Cíntia ~ Cíntias) sem relação real.
// O vetor carrega só SEMÂNTICA (papel, empresa, setor, notas, observações); busca por
// NOME é responsabilidade do LIKE — recall híbrido (nameMatchesFor em index.ts) e
// fallback textual do grafo. Entidade sem substância além do nome → texto VAZIO →
// sem vetor (o caller remove do índice; ver reembedEntity em entity-write.ts).
// Andaimes/carimbos de importação em notes_text NÃO são semântica: idênticos em
// milhares de contatos, geravam vetores IGUAIS (pares de similaridade score 1.0
// entre pessoas sem relação real — visto no reembed de 10/07/2026, quando o nome
// saiu do texto e o carimbo virou o vetor inteiro de 3.848 contatos). Remove o
// andaime constante e preserva o conteúdo que DISTINGUE (rótulos do Google, nomes
// de grupos, títulos de negócios, texto livre).
const NOTES_BOILERPLATE: RegExp[] = [
  /imported from Google Contacts[ 0-9-]*/gi,
  /Google labels:\s*/gi, // os RÓTULOS ficam; só o prefixo constante sai
  /Mapeado da rede de grupos( do [\wÀ-ÿ]+)?\.?\s*/gi,
  /Participa de:\s*/gi, // os NOMES DE GRUPO ficam
  /CRM Pipedrive:\s*\d+\s*negocio\(s\)\s*\([^)]*\)\.?\s*/gi,
  /Destaque:\s*/gi, // o TÍTULO do negócio fica
];

export function semanticNotesText(notes?: string | null): string | null {
  if (!notes) return null;
  let out = notes;
  for (const re of NOTES_BOILERPLATE) out = out.replace(re, " ");
  out = out
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s|.,;:]+/, "")
    .replace(/[\s|]+$/, "")
    .trim();
  return out || null;
}

export function embeddingTextFor(e: {
  name?: string;
  role?: string | null;
  company?: string | null;
  sector?: string | null;
  website?: string | null;
  notes_text?: string | null;
  observations?: string | null;
}): string {
  const base = [e.role, e.company, e.sector, e.website, semanticNotesText(e.notes_text)]
    .filter(Boolean)
    .join(" — ")
    .slice(0, IDENTITY_MAX);
  return [base, e.observations ? `Observações: ${e.observations}` : null]
    .filter(Boolean)
    .join("\n")
    .slice(0, EMBEDDING_TEXT_MAX);
}

// Máximo de observações consideradas e teto por observação (spec 50-console-v2/60 §1).
const OBSERVATIONS_LIMIT = 10;
const OBSERVATION_CONTEXT_MAX = 280;

// Monta o bloco de OBSERVAÇÕES pro embedding: os `context` das últimas
// OBSERVATIONS_LIMIT events kind='note' da entidade (mais recentes primeiro),
// não-nulos, cada um truncado em OBSERVATION_CONTEXT_MAX chars, juntados por " · ".
// Retorna null se não houver observação. Fonte ÚNICA da query — reembedEntity,
// handleSaveEntity e handleReembedAll consomem daqui, sem duplicar SQL.
//
// Privacidade (spec 50-console-v2/61): `AND private = 0` INCONDICIONAL — observação
// privada NUNCA entra no vetor (invisível até pra busca semântica do próprio dono:
// confidencialidade > recall, trade-off documentado na spec). A coluna existe desde
// a migration 0007 (trilho src/db/migrate.ts), então o filtro é sempre aplicável.
export async function observationsTextFor(env: Env, entityId: string): Promise<string | null> {
  const rows = await env.DB.prepare(
    `SELECT context FROM events
      WHERE entity_id = ? AND kind = 'note' AND private = 0 AND context IS NOT NULL AND TRIM(context) <> ''
      ORDER BY ts DESC LIMIT ?`,
  )
    .bind(entityId, OBSERVATIONS_LIMIT)
    .all<{ context: string }>();
  const parts = (rows.results ?? [])
    .map((r) => (r.context ?? "").trim().slice(0, OBSERVATION_CONTEXT_MAX))
    .filter((s) => s.length > 0);
  return parts.length ? parts.join(" · ") : null;
}

// Só a OBSERVAÇÃO (event kind='note') alimenta o vetor. Contexto de interação
// (met/talked/meeting/email/message/...) é ruído semântico — o sinal durável é a
// observação (spec 50-console-v2/60 §2). Predicado isolado pra ser testável sem
// exigir binding de Vectorize/AI.
export function eventKindReembeds(kind: string): boolean {
  return kind === "note";
}

export async function computeEmbedding(env: Env, text: string): Promise<number[] | null> {
  if (!text.trim()) return null;
  try {
    const r: any = await env.AI.run("@cf/baai/bge-m3", { text });
    const vec = Array.isArray(r?.data?.[0]) ? r.data[0] : r?.data?.[0]?.embedding;
    if (Array.isArray(vec) && vec.length === 1024) return vec;
    console.warn("[embedding] formato inesperado:", JSON.stringify(r).slice(0, 200));
    return null;
  } catch (e: any) {
    console.error("[embedding] error:", e?.message || e);
    return null;
  }
}

export async function upsertVectorize(
  env: Env,
  id: string,
  vector: number[],
  metadata: Record<string, any>,
): Promise<void> {
  if (!env.VECTORIZE) return;
  try {
    await env.VECTORIZE.upsert([{ id, values: vector, metadata }]);
  } catch (e: any) {
    console.error("[vectorize.upsert] error:", e?.message || e);
  }
}

// Metadata canônica do vetor no Vectorize. Usada por handleSaveEntity,
// handleReembedAll e reembedEntity — NUNCA montar metadata inline (senão um
// caminho reescreve o vetor SEM category/raw e apaga o que o outro gravou).
// `raw` = import cru (name = número, sem letra) — habilita filtro nativo do
// Vectorize (spec 10-backend/20) além do pós-filtro em memória.
export function vectorMetadataFor(
  e: { name: string; kind: string; source?: string | null; category?: string | null },
  text: string,
): Record<string, any> {
  return {
    name: e.name,
    kind: e.kind,
    source: e.source ?? null,
    category: e.category ?? null,
    raw: !/[A-Za-z]/.test(e.name || ""),
    text: text.slice(0, 500),
  };
}
