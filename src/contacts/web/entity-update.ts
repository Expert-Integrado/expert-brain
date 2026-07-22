// POST /app/entity/update — edição de contato pelo Console (sessão de browser).
//
// Spec 30-features/36 (fase 3). Autenticação: requireSession (cookie mv_session),
// NUNCA Bearer de leitura — é edição humana via UI. Reusa a MESMA lógica de patch
// (updateEntityFields), validação de categoria (normalizeCategory) e reembed
// (reembedEntity) que o write-path REST/MCP (handleSaveEntity) usa — zero validação
// duplicada (Decisão 2 da spec).
//
// Campos editáveis fase 3:
//   pessoa:  name, phone, email, role, company (texto), birthday, category,
//            notes_text, last_contacted
//   empresa: name, website, sector, email, phone, category, notes_text
// Campo AUSENTE no body = não mexe (COALESCE). Campo presente com "" pra texto =
// grava vazio; category "" normaliza p/ null (não mexe) — mesma regra do REST.
//
// Concorrência otimista: body.expected_updated_at (o updated_at que a página
// carregou) → 409 se a linha mudou no meio (edição concorrente do agente MCP).
//
// Respostas:
//   200 { ok:true, id, action:'updated', updated_at, vectorize_action }
//   400 invalid json / id required / invalid category
//   404 entity_not_found
//   409 conflict (com updated_at atual pra a UI recarregar)

import type { Env } from "../env.js";
import { updateEntityFields, reembedEntity, normalizeCategory, type EntityPatch, patchAffectsEmbedding } from "../entity-write.js";
import { tryGooglePushNow } from "../google/push.js";
import { normalizePhone } from "../util/phone.js";
import { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor } from "../embedding.js";
import { refreshSimilarEdges, SIMILARITY_TOP_K, SIMILARITY_MIN_SCORE } from "./similarity.js";
import {
  collectChannelInputs, collectChannelRemovals, validateChannelInputs,
  persistChannels, legacyMirrorChannels, setPrimaryChannel, removeChannel,
} from "../channels.js";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });

// Campos de texto livre editáveis: presença no body (mesmo "") => grava.
// undefined (ausente) => não entra no patch (COALESCE preserva).
const TEXT_FIELDS = [
  "name", "email", "role", "company", "website", "sector",
  "birthday", "last_contacted", "notes_text",
] as const;

// Normaliza um campo de texto do body: só entra no patch se a CHAVE existe.
// "" (string vazia) vira "" (grava vazio, sobrescreve). Trim aplicado.
function textField(body: any, key: string): string | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v == null) return undefined; // null explícito = não mexe (igual REST)
  return String(v).trim();
}

export async function handleEntityUpdate(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const id = String(body?.id ?? "").trim();
  if (!id) return json({ ok: false, error: "id required" }, { status: 400 });

  // categoria: MESMA validação do REST (normaliza ""→null, valida contra o canon).
  const cat = normalizeCategory(body.category);
  if (!cat.ok) {
    return json({ ok: false, error: cat.error, allowed: cat.allowed }, { status: 400 });
  }

  // Canais (spec 55): valida ANTES de aplicar — inválido => 400, nada persiste.
  const channelInputs = collectChannelInputs(body);
  const channelsValidation = validateChannelInputs(channelInputs);
  if (!channelsValidation.ok) {
    return json({ ok: false, error: channelsValidation.error }, { status: 400 });
  }
  const channelsRemove = collectChannelRemovals(body);
  const setPrimary = body.set_primary_channel != null ? String(body.set_primary_channel) : "";

  // Monta o patch só com os campos PRESENTES no body (edição parcial).
  const patch: EntityPatch = {};
  for (const key of TEXT_FIELDS) {
    const v = textField(body, key);
    if (v !== undefined) (patch as any)[key] = v;
  }
  // telefone: normaliza (E.164 sem +) — mesma função do REST. "" vira null (não mexe).
  if ("phone" in body && body.phone != null) {
    patch.phone = normalizePhone(String(body.phone)) || null;
  }
  if (cat.value != null) patch.category = cat.value;

  // Nada pra mudar? Ainda assim confirma existência (404) e devolve updated_at.
  const expected = body.expected_updated_at != null ? String(body.expected_updated_at) : undefined;
  const result = await updateEntityFields(env, id, patch, expected);

  if (result.status === "not_found") {
    return json({ ok: false, error: "entity_not_found", id }, { status: 404 });
  }
  if (result.status === "conflict") {
    return json(
      { ok: false, error: "conflict", detail: "entidade editada em outro lugar — recarregue", updated_at: result.updated_at },
      { status: 409 },
    );
  }

  // Reembed só quando o patch mexe num campo do embedding (mesma regra de campos
  // que embeddingTextFor cobre). category NÃO dispara reembed (é filtro, não texto).
  let vectorize_action: string = "skipped";
  if (patchAffectsEmbedding(patch)) {
    const reembed = await reembedEntity(env, id, {
      embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor,
    });
    vectorize_action = reembed.action;
    // Recomputa as similar edges com o vetor recém-gravado (spec 10-backend/21 §1c) —
    // não-fatal: a edição do contato não pode falhar pela camada de similaridade.
    if (reembed.vector) {
      try {
        await refreshSimilarEdges(env, id, reembed.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
      } catch (e: any) {
        console.error("[entity-update] refreshSimilarEdges failed", id, e?.message || e);
      }
    }
  }

  // Cartela de canais (spec 55): espelha email/phone editados como canais primários,
  // aplica canais explícitos + remoções, e marca primário se pedido. NÃO-FATAL exceto
  // set_primary com colisão de telefone (400 explícito — merge é outra spec).
  try {
    const legacy = legacyMirrorChannels({ phone: patch.phone ?? null, email: patch.email });
    if (legacy.length) await persistChannels(env, id, legacy, []);
    if (channelsValidation.channels.length || channelsRemove.length) {
      await persistChannels(env, id, channelsValidation.channels, channelsRemove);
    }
    if (setPrimary) {
      const sp = await setPrimaryChannel(env, id, setPrimary);
      if (!sp.ok) return json({ ok: false, error: sp.error }, { status: 400 });
    }
  } catch (e: any) {
    console.error("[entity-update] persistChannels failed", id, e?.message || e);
  }

  // Write-back Google: se a edição enfileirou push (gates dentro do maybeEnqueue,
  // chamado por updateEntityFields), tenta enviar já — não-fatal por construção.
  await tryGooglePushNow(env, id);

  return json({ ok: true, id, action: "updated", updated_at: result.updated_at, vectorize_action });
}

// POST /app/entity/private { id, private: boolean } — toggle do selo de privacidade
// (spec 50-console-v2/61 item 6). SESSÃO obrigatória (gate no handler.ts) — este é o
// ÚNICO lugar que DESMARCA (private=false); o write path REST/MCP é one-way (só marca).
// Marcar/desmarcar a ENTIDADE NÃO reembeda (o filtro de visibilidade é na hidratação
// D1; o vetor da entidade não carrega o eixo de privacidade) — spec 61 §5.
export async function handleEntityPrivate(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const id = String(body?.id ?? "").trim();
  if (!id) return json({ ok: false, error: "id required" }, { status: 400 });
  if (typeof body?.private !== "boolean") {
    return json({ ok: false, error: "private (boolean) required" }, { status: 400 });
  }

  const ex = await env.DB.prepare("SELECT id FROM entities WHERE id = ?").bind(id).first<{ id: string }>();
  if (!ex) return json({ ok: false, error: "entity_not_found", id }, { status: 404 });

  await env.DB.prepare("UPDATE entities SET private = ? WHERE id = ?")
    .bind(body.private ? 1 : 0, id)
    .run();

  return json({ ok: true, id, private: body.private });
}

// POST /app/entity/channel_delete { id } — remove UM canal (sessão). Deriva a
// entidade do próprio canal; promove o próximo primário e reconcilia o espelho.
export async function handleChannelDelete(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const channelId = String(body?.id ?? "").trim();
  if (!channelId) return json({ ok: false, error: "id required" }, { status: 400 });

  const ch = await env.DB
    .prepare("SELECT id, entity_id FROM entity_channels WHERE id = ?")
    .bind(channelId)
    .first<{ id: string; entity_id: string }>();
  if (!ch) return json({ ok: false, error: "channel_not_found", id: channelId }, { status: 404 });

  const res = await removeChannel(env, ch.entity_id, channelId);
  if (!res.ok) return json({ ok: false, error: res.error ?? "remove_failed" }, { status: 400 });
  return json({ ok: true, id: channelId, entity_id: ch.entity_id });
}
