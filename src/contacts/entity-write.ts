// Núcleo de ESCRITA de entidade — fonte ÚNICA da lógica de patch/reembed/concorrência.
//
// Extraído de handleSaveEntity (src/index.ts) pra ser reusado por DOIS caminhos
// sem duplicar validação (spec 30-features/36, Decisão 2):
//   1. REST/MCP: POST /save_person|save_company|save_entity  (auth Bearer OWNER_TOKEN)
//   2. Console (sessão de browser): POST /app/entity/update    (auth requireSession)
//
// Regras idênticas nos dois: categoria normaliza ''→null e valida contra
// CONTACT_CATEGORIES; telefone via normalizePhone; COALESCE preserva campo omitido
// (null = não mexe). Concorrência otimista opcional via expected_updated_at
// (WHERE ... AND updated_at = ?) — mesmo padrão de updateTask do expert-brain.
//
// `updated_at` de entities é TEXT ISO (`datetime('now')`), mantido pelo TRIGGER
// entities_set_updated (migration 0002) — o AFTER UPDATE grava um novo timestamp
// mesmo quando o UPDATE veio com AND updated_at = ?, então o guard compara o valor
// que a página CARREGOU contra o valor ATUAL na linha (pré-trigger).

import type { Env } from "./env";
import { normalizePhone } from "./util/phone";
import { CONTACT_CATEGORIES, CONTACT_CATEGORIES_SET } from "./canon";
// Import direto (sem ciclo: embedding.ts não importa este módulo nem index.ts) da
// fonte única do bloco de observações que alimenta o embedding (spec 50-console-v2/60).
import { observationsTextFor } from "./embedding";
// Limpeza das similar edges quando a entidade sai do índice (texto de embedding
// vazio — nome fora do vetor desde 10/07/2026). similarity.ts só importa env: sem ciclo.
import { replaceSimilarEdges } from "./web/similarity";
// Write-back Google (specs/google-contacts-sync.md): edição de identidade no
// caminho canônico enfileira o push vault→Google. push.ts não importa este módulo
// (sem ciclo). O PULL do gsync passa enqueueGooglePush:false — anti-loop.
import { maybeEnqueueGooglePush } from "./google/push";

// Campos editáveis (fase 3 da spec 36) — subconjunto do SaveBody que a UI edita.
// pessoa: name, phone, email, role, company (texto), birthday, category, notes_text,
//         last_contacted, website/sector (só company). Campos ausentes = não mexe.
export interface EntityPatch {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  role?: string | null;
  company?: string | null;
  website?: string | null;
  sector?: string | null;
  birthday?: string | null;
  last_contacted?: string | null;
  source?: string | null;
  notes_text?: string | null;
  attributes?: string | null; // JSON já serializado
  category?: string | null;
  // Selo de privacidade (spec 61): one-way via este patch — só 1 (marca) ou undefined
  // (não mexe). Desmarcar (0) é EXCLUSIVO do toggle da UI logada (POST /app/entity/private),
  // nunca deste caminho compartilhado REST/MCP.
  private?: 1;
}

// Campos que disparam reembed quando mudam. "name" continua aqui mesmo estando FORA
// do texto do vetor: o rename precisa refrescar a METADATA (name/raw) do Vectorize e,
// no caso só-nome, disparar a remoção do índice (removed_empty).
const EMBEDDING_FIELDS = new Set([
  "name",
  "role",
  "company",
  "sector",
  "website",
  "notes_text",
]);

export type CategoryResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string; allowed: string[] };

// Normaliza + valida categoria — MESMA regra do handleSaveEntity:
// ""/whitespace → null (não mexe no COALESCE), lower/trim, valida contra o canon.
// null (campo ausente) passa direto como "não mexe".
export function normalizeCategory(raw: unknown): CategoryResult {
  if (raw == null) return { ok: true, value: null };
  const value = String(raw).trim().toLowerCase() || null;
  if (value && !CONTACT_CATEGORIES_SET.has(value)) {
    return { ok: false, error: `invalid category: ${value}`, allowed: [...CONTACT_CATEGORIES] };
  }
  return { ok: true, value };
}

export type UpdateEntityResult =
  | { status: "ok"; updated_at: string }
  | { status: "not_found" }
  | { status: "conflict"; updated_at: string | null };

// COALESCE UPDATE por id, idêntico ao ramo `existing` de handleSaveEntity, com
// concorrência otimista opcional. Retorna sentinelas — NÃO lança pra fluxo normal.
//
// `patch` já vem com valores normalizados (phone via normalizePhone, category via
// normalizeCategory, attributes já serializado). Campo `undefined` NÃO deve chegar
// aqui — o caller converte pra null (não mexe). Passar null preserva o valor atual.
export async function updateEntityFields(
  env: Env,
  id: string,
  patch: EntityPatch,
  expectedUpdatedAt?: string | null,
  opts?: { enqueueGooglePush?: boolean },
): Promise<UpdateEntityResult> {
  const current = await env.DB
    .prepare("SELECT updated_at FROM entities WHERE id = ?")
    .bind(id)
    .first<{ updated_at: string }>();
  if (!current) return { status: "not_found" };

  // Guard de concorrência: se a página carregou um updated_at e ele NÃO bate com o
  // atual, alguém (agente MCP / outra aba) editou no meio — 409, sem sobrescrever.
  if (expectedUpdatedAt != null && expectedUpdatedAt !== "" && current.updated_at !== expectedUpdatedAt) {
    return { status: "conflict", updated_at: current.updated_at };
  }

  const p = (v: string | null | undefined): string | null => (v == null ? null : v);
  // private: COALESCE(?, private) com ? = 1 (marca) ou null (não mexe) — one-way,
  // o valor 0 nunca chega aqui (o caller REST rejeita `private:false` antes).
  await env.DB
    .prepare(
      `UPDATE entities SET
         name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email),
         role = COALESCE(?, role), company = COALESCE(?, company), website = COALESCE(?, website),
         sector = COALESCE(?, sector), birthday = COALESCE(?, birthday),
         last_contacted = COALESCE(?, last_contacted), source = COALESCE(?, source),
         notes_text = COALESCE(?, notes_text), attributes = COALESCE(?, attributes),
         category = COALESCE(?, category), private = COALESCE(?, private)
       WHERE id = ?`,
    )
    .bind(
      p(patch.name), p(patch.phone), p(patch.email), p(patch.role), p(patch.company),
      p(patch.website), p(patch.sector), p(patch.birthday), p(patch.last_contacted),
      p(patch.source), p(patch.notes_text), p(patch.attributes), p(patch.category),
      patch.private ?? null, id,
    )
    .run();

  // Write-back Google: default ligado — qualquer call site futuro do caminho
  // canônico ganha o push de graça; só o pull do gsync opta por sair (anti-loop).
  // maybeEnqueueGooglePush filtra sozinho (campo de identidade/toggle/scope/link)
  // e nunca lança — o save jamais falha por causa do write-back.
  if (opts?.enqueueGooglePush !== false) {
    await maybeEnqueueGooglePush(env, id, patch as Record<string, unknown>);
  }

  // Lê o updated_at pós-trigger pra devolver o novo token de concorrência à UI.
  const after = await env.DB
    .prepare("SELECT updated_at FROM entities WHERE id = ?")
    .bind(id)
    .first<{ updated_at: string }>();
  return { status: "ok", updated_at: after?.updated_at ?? current.updated_at };
}

// Resultado do reembed: a ação (pro campo `vectorize_action` da resposta) + o VETOR
// recém-computado. O vetor volta pro caller poder recomputar as similar edges
// (refreshSimilarEdges) SEM um segundo round-trip ao Vectorize — getByIds logo após
// um upsert é eventual-consistent (o vetor recém-gravado pode não voltar ainda), então
// reusar o vetor que já temos em mãos é o único caminho correto (spec 10-backend/21 §1c).
export type ReembedResult = {
  action: "upserted" | "skipped" | "embedding_failed" | "removed_empty";
  vector: number[] | null;
};

// Reembed do vetor da entidade (campos finais pós-UPDATE). Idêntico ao bloco de
// embedding de handleSaveEntity — extraído pra os dois caminhos reindexarem igual.
// Injetado com computeEmbedding/upsertVectorize/vectorMetadataFor pra evitar ciclo
// de import com index.ts (que importa este módulo). Degradação graciosa: sem
// VECTORIZE, "skipped".
export async function reembedEntity(
  env: Env,
  id: string,
  deps: {
    embeddingTextFor: (e: any) => string;
    computeEmbedding: (env: Env, text: string) => Promise<number[] | null>;
    upsertVectorize: (env: Env, id: string, vec: number[], meta: Record<string, any>) => Promise<void>;
    vectorMetadataFor: (e: any, text: string) => Record<string, any>;
  },
): Promise<ReembedResult> {
  if (!env.VECTORIZE) return { action: "skipped", vector: null };
  const finalE = await env.DB
    .prepare("SELECT name, kind, role, company, sector, website, notes_text, source, category FROM entities WHERE id = ?")
    .bind(id)
    .first<any>();
  if (!finalE) return { action: "skipped", vector: null };
  // Observações datadas (events kind='note') entram no texto do embedding junto da
  // identidade — recall semântico passa a achar por conteúdo de observação (spec 60 §1).
  const observations = await observationsTextFor(env, id);
  const text = deps.embeddingTextFor({ ...finalE, observations });
  // Sem substância além do nome (nome fora do vetor desde 10/07/2026): a entidade
  // SAI do índice — vetor deletado e similar_edges limpas. Senão o vetor antigo
  // (baseado em nome) ficaria stale gerando "Similares" por grafia pra sempre.
  if (!text.trim()) {
    try {
      await env.VECTORIZE.deleteByIds([id]);
    } catch (e: any) {
      console.error("[reembedEntity] deleteByIds failed", id, e?.message || e);
    }
    await replaceSimilarEdges(env, id, []);
    return { action: "removed_empty", vector: null };
  }
  const vec = await deps.computeEmbedding(env, text);
  if (!vec) return { action: "embedding_failed", vector: null };
  await deps.upsertVectorize(env, id, vec, deps.vectorMetadataFor(finalE, text));
  return { action: "upserted", vector: vec };
}

// True se o patch mexe em algum campo que compõe o embedding.
export function patchAffectsEmbedding(patch: EntityPatch): boolean {
  for (const k of Object.keys(patch)) {
    if (EMBEDDING_FIELDS.has(k) && (patch as any)[k] != null) return true;
  }
  return false;
}

// re-export pra o handler não reimportar de canon direto.
export { normalizePhone, CONTACT_CATEGORIES };
