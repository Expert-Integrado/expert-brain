// Núcleo de ESCRITA de EVENTOS (timeline de interação). Fonte ÚNICA usada pelos 3
// call-sites que registram uma interação (spec 50-console-v2/57):
//   1. REST:               POST /event                (src/index.ts, auth OWNER_TOKEN)
//   2. Console standalone: POST /app/entity/event      (sessão de cookie)
//   3. Proxy do Brain:     POST /app/contacts/entity/event → mesmo endpoint acima,
//                          via Bearer CONTACTS_WRITE_TOKEN (allowlist de 1 path)
//
// Extraído no MESMO padrão de reembedEntity (entity-write.ts): validação + insert +
// atualização de last_contacted + (quando o kind alimenta o embedding) reembed —
// tudo num lugar só, sem duplicar regra entre REST e Console.

import type { Env } from "./env";
import {
  EVENT_KINDS, EVENT_KINDS_SET, EVENT_SOURCES, EVENT_SOURCES_SET,
  LAST_CONTACTED_EVENT_KINDS_SET,
} from "./canon";
import { reembedEntity as reembedEntityShared } from "./entity-write";
import { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor, eventKindReembeds } from "./embedding";
import { refreshSimilarEdges, SIMILARITY_TOP_K, SIMILARITY_MIN_SCORE } from "./web/similarity";

export interface RecordEventInput {
  entity_id: string;
  kind: string;
  context?: string | null;
  ts?: string | null;
  source?: string | null;
  // Selo de privacidade (spec 61): evento privado (observação sensível). NUNCA entra
  // no embedding (observationsTextFor filtra) e some da timeline do proxy sem header.
  private?: boolean;
}

export type RecordEventResult =
  | { status: "ok"; id: string }
  | { status: "missing_fields" }
  | { status: "invalid_kind"; allowed: readonly string[] }
  | { status: "invalid_source"; allowed: readonly string[] }
  | { status: "not_found" };

// Teto defensivo do contexto (a UI limita a 2000 no textarea — spec 57 §4; aqui é
// só uma rede de segurança contra POST direto sem passar pela UI).
const CONTEXT_MAX = 2000;

// Janela de dedupe pra double-submit do botão "Registrar interação" (spec 57,
// riscos e reversão): mesma entity+kind+context nos últimos 5s → idempotente,
// devolve o id já gravado em vez de duplicar a linha.
const DEDUPE_WINDOW_SECONDS = 5;

// Registra UM evento (interação) pra uma entidade. `ctx` é opcional: quando vem
// (contexto de fetch handler com ExecutionContext), o reembed pós-observação roda
// via waitUntil (não bloqueia a resposta); sem ele, roda inline (await).
export async function recordEvent(
  env: Env,
  input: RecordEventInput,
  ctx?: ExecutionContext,
): Promise<RecordEventResult> {
  const entityId = (input.entity_id || "").trim();
  const kind = input.kind;
  if (!entityId || !kind) return { status: "missing_fields" };
  // restaura na app o CHECK que a migration 0002 dropou do schema — typo (ex:
  // 'talkd') não entra mais silenciosamente (spec 19 §6).
  if (!EVENT_KINDS_SET.has(kind)) return { status: "invalid_kind", allowed: EVENT_KINDS };
  if (input.source != null && !EVENT_SOURCES_SET.has(input.source)) {
    return { status: "invalid_source", allowed: EVENT_SOURCES };
  }

  const entity = await env.DB.prepare("SELECT id FROM entities WHERE id = ?").bind(entityId).first();
  if (!entity) return { status: "not_found" };

  const context = input.context != null ? String(input.context).slice(0, CONTEXT_MAX) : null;

  if (context) {
    const dup = await env.DB.prepare(
      `SELECT id FROM events WHERE entity_id = ? AND kind = ? AND context = ?
         AND ts >= datetime('now', ?) ORDER BY ts DESC LIMIT 1`,
    )
      .bind(entityId, kind, context, `-${DEDUPE_WINDOW_SECONDS} seconds`)
      .first<{ id: string }>();
    if (dup) return { status: "ok", id: dup.id };
  }

  const id = crypto.randomUUID();
  const priv = input.private === true ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO events (id, entity_id, kind, ts, context, source, private)
     VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, COALESCE(?, 'manual'), ?)`,
  )
    .bind(id, entityId, kind, input.ts ?? null, context, input.source ?? null, priv)
    .run();

  if (LAST_CONTACTED_EVENT_KINDS_SET.has(kind)) {
    // last_contacted segue o ts do EVENTO (normalizado pra 'YYYY-MM-DD HH:MM:SS'
    // UTC) e nunca retrocede — carga histórica não pode puxar pra hora da gravação
    // (adendo 11/07 em 9zfjcquprh03). ts ausente/inválido cai pra now.
    await env.DB.prepare(
      `UPDATE entities SET last_contacted = CASE
         WHEN last_contacted IS NULL THEN COALESCE(datetime(?), datetime('now'))
         ELSE MAX(last_contacted, COALESCE(datetime(?), datetime('now')))
       END WHERE id = ?`,
    ).bind(input.ts ?? null, input.ts ?? null, entityId).run();
  }

  // Observação (kind='note') alimenta o vetor → reembeda a entidade (spec 60 §2).
  // Demais kinds (met/talked/meeting/email/message/...) são interação, não alteram
  // o sinal semântico durável — não reembedam (eventKindReembeds).
  if (eventKindReembeds(kind)) {
    const reembed = reembedAfterEvent(env, entityId).catch((e: any) =>
      console.error("[events] reembed pós-observação falhou", entityId, e?.message || e),
    );
    if (ctx) ctx.waitUntil(reembed);
    else await reembed;
  }

  return { status: "ok", id };
}

async function reembedAfterEvent(env: Env, id: string): Promise<void> {
  const reembed = await reembedEntityShared(env, id, {
    embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor,
  });
  if (reembed.vector) {
    try {
      await refreshSimilarEdges(env, id, reembed.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    } catch (e: any) {
      console.error("[events] refreshSimilarEdges failed", id, e?.message || e);
    }
  }
}
