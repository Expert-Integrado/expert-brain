/**
 * Expert Contacts — Worker v0.4 (modelo de ENTIDADES / grafo)
 *
 * Stack: Cloudflare D1 + Workers AI (bge-m3) + Vectorize + R2.
 *
 * Modelo: grafo de entidades (kind = person | company | ...) com arestas
 * polimórficas (qualquer nó ↔ qualquer nó). Mesma filosofia do Expert Brain:
 * nós uniformes + edges com `why` substantivo (≥20 chars). Pessoas e empresas
 * são bolinhas; connections são as linhas; clustering semântico via Vectorize.
 *
 * Degradação graciosa: VECTORIZE/MEDIA ausentes → 503 limpo nas rotas que dependem.
 * Auth: Bearer OWNER_TOKEN.
 *
 * Rotas principais:
 *   GET  /health
 *   POST /save_person | /save_company | /save_entity   (upsert nó)
 *   GET  /entities/:id  (alias /people/:id)             (nó + conexões + eventos + mídia)
 *   GET  /entities/:id/media  (alias /people/:id/media)
 *   GET  /recall_entity | /recall_person ?q=&kind=      (semântico, filtro por kind)
 *   GET  /list_entities ?kind=  |  /list_people         (listagem)
 *   POST /connect       (aresta a_id↔b_id, tipos pessoa/empresa)
 *   POST /event         (log; entity_id ou person_id)
 *   POST /attach_media  | GET /media/:hash
 *   GET  /graph/data    (nós + arestas pro front de grafo)
 *   POST /setup/reembed
 *   DELETE /entities/:id?confirm=true    (HARD delete: cascade + vetor + R2 refcount)
 *   DELETE /connections/:id?confirm=true (remove só a aresta)
 *   POST /entities/merge {winner_id, loser_id, confirm:true} (funde duplicatas)
 *
 * Destrutivas (spec 30-features/34): delete é HARD (sem lixeira) — vault derivado
 * de fontes re-importáveis. confirm obrigatório; só OWNER_TOKEN; log [destructive].
 *
 * Co-hospeda também o Expert Console (front multi-vault) sob /app* — ver
 * src/web/handler.ts. O Console roda antes do roteamento da API e só intercepta
 * /app*; as rotas da API de entidades seguem intactas.
 */

import type { Env } from "./env";
import { handleApp } from "./web/handler";
import { handleGetMedia } from "./media";
import { timingSafeEqualStr, proxyTokenAllowsPath, writeTokenAllowsPath } from "./auth/tokens";
import {
  handleGoogleStatus, handleGoogleLabels, handleGoogleConnectStart, handleGoogleCallback,
  handleGoogleConfig, handleGoogleSyncRun, handleGoogleDisconnect, handleGoogleClientPost,
  handleGoogleWriteBackPost,
} from "./google/routes";
import { runGoogleSync, trackGsyncOutcome } from "./google/sync";
import { drainGooglePushQueue, tryGooglePushNow, maybeEnqueueGooglePush } from "./google/push";
import {
  requireWaSyncAuth, handleWaCatalogPush, handleWaConfigGet, handleWaImport,
  handleWaInteractionsImport,
  handleWaStatus, handleWaAllowlistPost, handleWaCreateMembersPost,
} from "./whatsapp/routes";
import {
  requireIgSyncAuth, handleIgCatalogPush, handleIgConfigGet, handleIgImport,
  handleIgStatus, handleIgAllowlistPost, handleIgDossier, handleIgPush,
} from "./instagram/routes";
import { normalizePhone, phoneVariants } from "./util/phone";
import { runMigrations } from "./db/migrate";
import { runSnapshotRecorded, SNAPSHOT_CRON } from "./backup/snapshot";
import {
  CONN_TYPES, CONN_TYPES_SET, SYMMETRIC_CONN_TYPES, ENTITY_KINDS, ENTITY_KINDS_SET,
  CONTACT_CATEGORIES, EVENT_KINDS,
  EVENT_SOURCES, normalizeConnPair, HIDDEN_BY_DEFAULT_CATEGORY,
} from "./canon";
import { updateEntityFields, reembedEntity as reembedEntityShared, normalizeCategory } from "./entity-write";
import { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor, observationsTextFor } from "./embedding";
import { refreshSimilarEdges, replaceSimilarEdges, SIMILARITY_TOP_K, SIMILARITY_MIN_SCORE } from "./web/similarity";
import {
  collectChannelInputs, collectChannelRemovals, validateChannelInputs,
  persistChannels, legacyMirrorChannels, getChannels, channelHref,
} from "./channels";
import { recordEvent } from "./events";
import { callerSeesPrivate } from "./web/privacy";
export { vectorMetadataFor };

// Enums canônicos (CONN_TYPES / ENTITY_KINDS / CONTACT_CATEGORIES / EVENT_KINDS)
// vivem em src/canon.ts — fonte ÚNICA consumida por Worker e Console.

// --------- helpers ---------
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init?.headers },
  });

const err = (status: number, message: string, extra?: unknown) =>
  json({ ok: false, error: message, ...(extra ? { detail: extra } : {}) }, { status });

const uuid = () => crypto.randomUUID();

// Parse de inteiro com clamp — evita NaN → 500 no bind do D1 quando o cliente
// manda ?limit=abc. Retorna o default se não parsear; clampa em [min, max].
function parseIntSafe(v: string | null, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = parseInt(v ?? "", 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(n, max));
}

function requireAuth(req: Request, env: Env): Response | null {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (env.OWNER_TOKEN && timingSafeEqualStr(token, env.OWNER_TOKEN)) return null;
  // CONTACTS_PROXY_TOKEN (spec 10-backend/24): leitura ESCOPADA — só os paths da
  // allowlist canônica em src/auth/tokens.ts (recall, lookup por telefone, detalhe
  // de 1 entidade, list limitado do resurface, canon, mídia por hash). Qualquer
  // GET novo nasce 401 pro proxy token; escritas (POST) seguem exigindo OWNER_TOKEN.
  if (
    env.CONTACTS_PROXY_TOKEN &&
    req.method === "GET" &&
    timingSafeEqualStr(token, env.CONTACTS_PROXY_TOKEN) &&
    proxyTokenAllowsPath(new URL(req.url).pathname)
  ) return null;
  // CONTACTS_WRITE_TOKEN (specs/google-contacts-sync.md): mutações ESCOPADAS do
  // estado do sync do Google — allowlist canônica em src/auth/tokens.ts. Qualquer
  // outro POST segue exigindo OWNER_TOKEN.
  if (
    env.CONTACTS_WRITE_TOKEN &&
    req.method === "POST" &&
    timingSafeEqualStr(token, env.CONTACTS_WRITE_TOKEN) &&
    writeTokenAllowsPath(new URL(req.url).pathname)
  ) return null;
  return err(401, "unauthorized");
}

// normalizePhone / phoneVariants extraídos pra src/util/phone.ts (testabilidade).
// embeddingTextFor / computeEmbedding / upsertVectorize / vectorMetadataFor
// extraídos pra src/embedding.ts (fonte ÚNICA compartilhada com o Console).
// vectorMetadataFor re-exportado abaixo p/ back-compat (test/vector-metadata.test.ts
// importa de ../src/index).

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = b64.includes(",") ? b64.split(",", 2)[1] : b64;
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --------- handlers ---------

async function handleHealth(env: Env): Promise<Response> {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM entities) AS entities,
       (SELECT COUNT(*) FROM entities WHERE kind='person') AS persons,
       (SELECT COUNT(*) FROM entities WHERE kind='company') AS companies,
       (SELECT COUNT(*) FROM connections) AS connections,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM media) AS media`
  ).first<any>();
  // Bloco maint (spec 40-ops/43): estado do cron de manutenção pro monitor
  // externo. Aditivo; falha de KV degrada pro default em vez de derrubar o /health.
  let maint: { last_run: string | null; consecutive_failures: number; cursor_pending: boolean } = {
    last_run: null,
    consecutive_failures: 0,
    cursor_pending: false,
  };
  try {
    const [lastRun, cf, cursor] = await Promise.all([
      env.CACHE.get("maint:last_run"),
      env.CACHE.get("maint:consecutive_failures"),
      env.CACHE.get("maint:cursor"),
    ]);
    maint = {
      last_run: lastRun,
      consecutive_failures: parseInt(cf ?? "0", 10) || 0,
      cursor_pending: !!cursor,
    };
  } catch { /* KV transiente: /health responde com o default */ }
  return json({
    ok: true,
    service: "expert-contacts",
    version: "0.4.0",
    model: "entities-graph",
    counts: counts || {},
    maint,
    vectorize_enabled: !!env.VECTORIZE,
    r2_enabled: !!env.MEDIA,
    embedding_model: "@cf/baai/bge-m3",
  });
}

type SaveBody = {
  id?: string;
  kind?: string;
  name: string;
  phone?: string;
  email?: string;
  role?: string;
  company?: string;
  website?: string;
  sector?: string;
  birthday?: string;
  last_contacted?: string;
  source?: string;
  notes_text?: string;
  attributes?: any;
  category?: string;
  mentions_contacts?: string[];
  brain_note_id?: string;
  // Selo de privacidade (spec 61): one-way via API — `true` marca; `false` é ERRO
  // (desmarcar só na UI logada). Ausente = não mexe.
  private?: boolean;
  // cartela de canais (spec 55). Array explícito + atalhos (viram canais no servidor).
  channels?: Array<{ kind?: unknown; value?: unknown; label?: unknown; primary?: unknown }>;
  channels_remove?: unknown;
  emails?: unknown;
  instagram?: unknown;
  linkedin?: unknown;
  crm_url?: unknown;
  manychat_id?: unknown;
};

async function handleSaveEntity(req: Request, env: Env, forcedKind?: string): Promise<Response> {
  let body: SaveBody;
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (!body.name || body.name.trim().length < 1) return err(400, "name required");

  const kind = (forcedKind || body.kind || "person").toLowerCase();
  if (!ENTITY_KINDS_SET.has(kind)) return err(400, `invalid kind: ${kind}`);
  // Privacidade (spec 61): one-way. `private:true` marca; `private:false` via API é
  // ERRO (desmarcar só no console logado — espelho da regra da 31 no Brain). Ausente
  // = não mexe. `markPrivate` alimenta o INSERT (private=1) e o patch do UPDATE.
  if (body.private === false) {
    return err(400, "unmarking private is only possible in the logged-in console UI (POST /app/entity/private)");
  }
  const markPrivate = body.private === true;
  const phone = normalizePhone(body.phone);
  // proveniência: source NUNCA sobrescreve no update — só entra quando enviado
  // válido (string não-vazia). O default 'manual' vale SÓ no INSERT (ver abaixo).
  const source = body.source?.trim() || null;
  const attrs = body.attributes != null ? JSON.stringify(body.attributes) : null;
  // categoria: normaliza ""→null e valida contra o canon via fonte ÚNICA
  // (entity-write.ts) — mesma regra que o endpoint de sessão do Console usa.
  const cat = normalizeCategory(body.category);
  if (!cat.ok) return err(400, cat.error, { allowed: cat.allowed });
  const category = cat.value;

  // Canais (spec 55): coleta atalhos + array explícito e VALIDA antes de qualquer
  // escrita — valor inválido (email sem @, crm sem http) => 400, NADA persiste.
  const channelInputs = collectChannelInputs(body);
  const channelsValidation = validateChannelInputs(channelInputs);
  if (!channelsValidation.ok) return err(400, channelsValidation.error);
  const channelsRemove = collectChannelRemovals(body);

  // resolve existente: id → phone variants (person) → nome exato (company)
  let existing: { id: string } | null = null;
  if (body.id) {
    existing = await env.DB.prepare("SELECT id FROM entities WHERE id = ?").bind(body.id).first<{ id: string }>();
  } else if (kind === "person" && phone) {
    // dedupe por variantes do 9º dígito (mesma técnica de handleContactByPhone):
    // 55DDXXXXXXXX (sem 9) e 55DD9XXXXXXXX (com 9) resolvem pra MESMA entidade.
    // ORDER BY prioriza o match EXATO quando ambas as variantes existem.
    const variants = phoneVariants(phone);
    const list = variants.length ? variants : [phone];
    const ph = list.map(() => "?").join(",");
    existing = await env.DB.prepare(
      `SELECT id FROM entities WHERE phone IN (${ph}) ORDER BY (phone = ?) DESC LIMIT 1`
    ).bind(...list, phone).first<{ id: string }>();
    // fallback: a dedupe precisa espelhar o LOOKUP (handleContactByPhone) — número
    // que só vive em entity_channels kind='phone' também resolve, senão duplica.
    if (!existing) {
      existing = await env.DB.prepare(
        `SELECT e.id FROM entity_channels ch JOIN entities e ON e.id = ch.entity_id
          WHERE ch.kind = 'phone' AND ch.value IN (${ph}) LIMIT 1`
      ).bind(...list).first<{ id: string }>();
    }
  } else if (kind === "company" || kind === "group") {
    // empresas e grupos são idempotentes por nome (case-insensitive)
    existing = await env.DB.prepare(
      "SELECT id FROM entities WHERE kind = ? AND LOWER(name) = LOWER(?)"
    ).bind(kind, body.name).first<{ id: string }>();
  }

  const id = existing?.id || body.id || uuid();
  let action: "created" | "updated";

  if (existing) {
    // COALESCE UPDATE via fonte ÚNICA (entity-write.ts) — mesma função que o
    // endpoint de sessão do Console chama. Sem expected_updated_at aqui:
    // REST/MCP mantém last-write-wins por omissão (retrocompatível, deliberado).
    await updateEntityFields(env, id, {
      name: body.name, phone, email: body.email ?? null, role: body.role ?? null,
      company: body.company ?? null, website: body.website ?? null, sector: body.sector ?? null,
      birthday: body.birthday ?? null, last_contacted: body.last_contacted ?? null,
      source, notes_text: body.notes_text ?? null, attributes: attrs, category,
      // one-way: só 1 (marca); nunca 0 daqui (o `false` já virou erro acima).
      private: markPrivate ? 1 : undefined,
    });
    action = "updated";
    // Write-back Google: se a edição enfileirou push (gates dentro do próprio
    // maybeEnqueue, chamado por updateEntityFields), tenta enviar já — não-fatal.
    await tryGooglePushNow(env, id);
  } else {
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, email, role, company, website, sector, birthday, last_contacted, source, notes_text, attributes, category, private)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, kind, body.name, phone, body.email ?? null, body.role ?? null, body.company ?? null,
      body.website ?? null, body.sector ?? null, body.birthday ?? null, body.last_contacted ?? null,
      source ?? "manual", body.notes_text ?? null, attrs, category, markPrivate ? 1 : 0
    ).run();
    action = "created";
  }

  // embedding (campos finais). category entra só na metadata (filtro), NÃO no texto
  // do embedding — embeddingTextFor ignora category de propósito. Reembed via fonte
  // ÚNICA (entity-write.ts) — o endpoint do Console reindexará com a MESMA lógica.
  const reembed = await reembedEntityShared(env, id, {
    embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor,
  });
  const vectorize_action = reembed.action;
  // Recomputa as similar edges com o vetor recém-gravado (spec 10-backend/21 §1c).
  // NÃO-FATAL: se falhar (ex: vizinho órfão viola FK), a entidade fica salva e o
  // backfill/próximo edit corrige — o save NUNCA pode falhar pela camada de similaridade.
  if (reembed.vector) {
    try {
      await refreshSimilarEdges(env, id, reembed.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    } catch (e: any) {
      console.error("[save_entity] refreshSimilarEdges failed", id, e?.message || e);
    }
  }

  // Cartela de canais (spec 55). 1) espelha os params legados (email/phone/website)
  // como canais primários — mantém coluna==canal primário; 2) aplica os canais
  // explícitos/atalhos (já validados) e as remoções. NÃO-FATAL: o save nunca falha
  // pela camada de canais (a entidade já está persistida).
  try {
    const legacy = legacyMirrorChannels({ phone, email: body.email, kind, website: body.website });
    if (legacy.length) await persistChannels(env, id, legacy, []);
    if (channelsValidation.channels.length || channelsRemove.length) {
      await persistChannels(env, id, channelsValidation.channels, channelsRemove);
    }
  } catch (e: any) {
    console.error("[save_entity] persistChannels failed", id, e?.message || e);
  }

  // bridge Brain → Contacts
  let bridge_events = 0;
  if (body.mentions_contacts?.length) {
    for (const cid of body.mentions_contacts) {
      try {
        const ex = await env.DB.prepare("SELECT id FROM entities WHERE id = ?").bind(cid).first();
        if (!ex) continue;
        await env.DB.prepare(
          `INSERT INTO events (id, entity_id, kind, context, source)
           VALUES (?, ?, 'mentioned_in_brain', ?, 'brain_bridge')`
        ).bind(uuid(), cid, body.brain_note_id ? `brain_note:${body.brain_note_id}` : "brain_note_mention").run();
        bridge_events++;
      } catch (e: any) { console.warn("[bridge] failed", cid, e?.message); }
    }
  }

  return json({ ok: true, id, kind, action, vectorize_action, bridge_events });
}

async function handleGetEntity(id: string, env: Env, req: Request): Promise<Response> {
  // Privacidade (spec 61): entidade privada é 404 (indistinguível de inexistente)
  // pra quem não vê privados; vizinho/evento privado some do payload.
  const includePrivate = await callerSeesPrivate(req, env);
  const e = await env.DB.prepare("SELECT * FROM entities WHERE id = ?").bind(id).first<any>();
  if (!e || (!includePrivate && e.private === 1)) return err(404, "entity not found");
  const conns = await env.DB.prepare(
    `SELECT c.*, ea.name AS a_name, ea.kind AS a_kind, ea.private AS a_private,
            eb.name AS b_name, eb.kind AS b_kind, eb.private AS b_private
       FROM connections c
       JOIN entities ea ON ea.id = c.a_id
       JOIN entities eb ON eb.id = c.b_id
      WHERE c.a_id = ? OR c.b_id = ?`
  ).bind(id, id).all();
  const privEv = includePrivate ? "" : " AND private = 0";
  const events = await env.DB.prepare(
    `SELECT * FROM events WHERE entity_id = ?${privEv} ORDER BY ts DESC LIMIT 10`
  ).bind(id).all();
  // Omite conexões cujo OUTRO extremo é privado (quando o caller não vê privados).
  const connResults = (conns.results || []).filter((c: any) => {
    if (includePrivate) return true;
    const otherPrivate = c.a_id === id ? c.b_private : c.a_private;
    return otherPrivate !== 1;
  });
  const media = await env.DB.prepare(
    "SELECT id, kind, content_hash, mime_type, byte_size, caption, created_at FROM media WHERE entity_id = ? ORDER BY created_at DESC"
  ).bind(id).all();
  // canais (spec 55): cartela completa com href pronto (get_entity do MCP herda).
  const channels = await getChannels(env, id);
  return json({
    ok: true,
    entity: e,
    person: e, // alias back-compat
    connections: connResults,
    recent_events: events.results,
    media: (media.results || []).map((m: any) => ({ ...m, url: `/media/${m.content_hash}` })),
    channels: channels.map((c) => ({
      id: c.id, kind: c.kind, value: c.value, label: c.label,
      is_primary: c.is_primary === 1, position: c.position,
      href: channelHref(c.kind, c.value),
    })),
  });
}

async function handleListEntityMedia(id: string, env: Env): Promise<Response> {
  const ex = await env.DB.prepare("SELECT id FROM entities WHERE id = ?").bind(id).first();
  if (!ex) return err(404, "entity not found");
  const media = await env.DB.prepare(
    `SELECT id, kind, content_hash, mime_type, byte_size, caption, created_at
       FROM media WHERE entity_id = ? ORDER BY created_at DESC`
  ).bind(id).all();
  return json({
    ok: true,
    entity_id: id,
    count: media.results?.length ?? 0,
    media: (media.results || []).map((m: any) => ({ ...m, url: `/media/${m.content_hash}` })),
  });
}

// Matches determinísticos por NOME via LIKE. O nome saiu do texto de embedding
// (src/embedding.ts, 10/07/2026) — sem isto, buscar "Cíntia" no modo semântico não
// acharia mais a Cíntia. O recall híbrido mescla estes matches NO TOPO do resultado
// vetorial (mergeRecallResults). Mesmos filtros do caminho semântico: private
// fail-closed, kind, category e crus escondidos por padrão.
export async function nameMatchesFor(
  env: Env,
  q: string,
  opts: {
    limit: number;
    includePrivate: boolean;
    kindFilter?: string | null;
    categoryFilter?: string | null;
    includeRaw?: boolean;
  },
): Promise<any[]> {
  const like = `%${q.toLowerCase()}%`;
  const kindSql = opts.kindFilter ? "AND kind = ?" : "";
  // sem filtro explícito, 'mapeado' fica fora (sub-vault default-off — canon.ts)
  const catSql = opts.categoryFilter
    ? "AND category = ?"
    : `AND COALESCE(category,'') != '${HIDDEN_BY_DEFAULT_CATEGORY}'`;
  const rawSql = opts.includeRaw ? "" : "AND name GLOB '*[A-Za-z]*'";
  const privSql = opts.includePrivate ? "" : "AND private = 0";
  const binds: any[] = [like];
  if (opts.kindFilter) binds.push(opts.kindFilter);
  if (opts.categoryFilter) binds.push(opts.categoryFilter);
  binds.push(opts.limit);
  const r = await env.DB.prepare(
    `SELECT id, kind, name, phone, email, role, company, website, sector, source, last_contacted, category, avatar_r2_key
       FROM entities
      WHERE LOWER(name) LIKE ? ${kindSql} ${catSql} ${rawSql} ${privSql}
      ORDER BY last_contacted DESC NULLS LAST
      LIMIT ?`,
  ).bind(...binds).all();
  // score null = match por palavra (sem métrica vetorial), mesma convenção do Brain.
  return ((r.results ?? []) as any[]).map((row) => ({ ...row, score: null, match: "name" }));
}

// Mescla do recall híbrido: matches de NOME primeiro (determinísticos), depois os
// semânticos, dedup por id (o de nome vence), corte no limit.
export function mergeRecallResults(nameRows: any[], semanticRows: any[], limit: number): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of [...nameRows, ...semanticRows]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

async function handleRecall(url: URL, env: Env, req: Request): Promise<Response> {
  // Privacidade (spec 61): entidade privada nunca volta na busca pra quem não vê
  // privados — hidratação D1 do vetor filtra e o LIKE ganha AND private = 0.
  const includePrivate = await callerSeesPrivate(req, env);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = parseIntSafe(url.searchParams.get("limit"), 10, 1, 50);
  const kindFilter = url.searchParams.get("kind"); // person|company|null
  const categoryFilter = url.searchParams.get("category"); // cliente|lead|... |null
  // imports crus (name = número, sem letra) ficam ESCONDIDOS por padrão; include_raw=true mostra.
  const includeRaw = url.searchParams.get("include_raw") === "true";
  const hasLetter = (s: string) => /[A-Za-z]/.test(s || "");
  const mode = url.searchParams.get("mode") || (env.VECTORIZE ? "semantic" : "sql");
  if (q.length < 1) return err(400, "q required");

  if (mode === "semantic" && env.VECTORIZE) {
    // Recall HÍBRIDO: o nome está fora do vetor (embedding.ts), então busca por nome
    // entra via LIKE e é mesclada no topo do resultado semântico.
    const nameRows = await nameMatchesFor(env, q, {
      limit, includePrivate, kindFilter, categoryFilter, includeRaw,
    });
    const vec = await computeEmbedding(env, q);
    if (!vec) return err(500, "embedding failed for query");
    // over-fetch quando há filtro pós-hydrate (kind/category/crus) p/ não perder
    // resultados. includeRaw=false por padrão → o filtro de crus (linha ~371) sempre
    // derruba candidatos, então precisamos over-fetchar mesmo sem kind/category, senão
    // com ~75% do índice cru os `limit` vizinhos podem ser TODOS crus e o recall
    // devolveria count:0 mesmo existindo nomeados relevantes (spec 10-backend/20).
    const topK = (kindFilter || categoryFilter || !includeRaw) ? Math.min(50, limit * 4) : limit;
    let queryRes: any;
    try {
      queryRes = await env.VECTORIZE.query(vec, { topK, returnMetadata: true });
    } catch (e: any) {
      return err(500, "vectorize.query failed", String(e?.message || e));
    }
    const matches = queryRes?.matches || [];
    const ids = matches.map((m: any) => m.id);
    if (!ids.length) {
      // sem matches vetoriais, os de NOME ainda valem (recall híbrido)
      const only = nameRows.slice(0, limit);
      return json({ ok: true, query: q, mode: "semantic", count: only.length, results: only });
    }
    const ph = ids.map(() => "?").join(",");
    // O Vectorize pode devolver ids de entidade privada no topK; a hidratação D1 é a
    // fonte de verdade — `AND private = 0` os derruba pra quem não vê privados (o
    // caller recebe menos resultados, nunca resultados errados; mesmo padrão da 31).
    const privHy = includePrivate ? "" : " AND private = 0";
    const hydrated = await env.DB.prepare(
      `SELECT id, kind, name, phone, email, role, company, website, sector, source, last_contacted, category, avatar_r2_key FROM entities WHERE id IN (${ph})${privHy}`
    ).bind(...ids).all();
    const byId = new Map<string, any>();
    for (const row of hydrated.results || []) byId.set((row as any).id, row);
    let results = matches
      .map((m: any) => { const e = byId.get(m.id); return e ? { ...e, score: m.score } : null; })
      .filter(Boolean) as any[];
    if (kindFilter) results = results.filter((r) => r.kind === kindFilter);
    if (categoryFilter) results = results.filter((r) => r.category === categoryFilter);
    else results = results.filter((r) => r.category !== HIDDEN_BY_DEFAULT_CATEGORY);
    if (!includeRaw) results = results.filter((r) => hasLetter(r.name));
    results = mergeRecallResults(nameRows, results, limit);
    return json({ ok: true, query: q, mode: "semantic", count: results.length, results });
  }

  // fallback SQL LIKE
  const like = `%${q.toLowerCase()}%`;
  const kindSql = kindFilter ? "AND kind = ?" : "";
  const catSql = categoryFilter
    ? "AND e.category = ?"
    : `AND COALESCE(e.category,'') != '${HIDDEN_BY_DEFAULT_CATEGORY}'`;
  const rawSql = includeRaw ? "" : "AND name GLOB '*[A-Za-z]*'";
  // Privacidade (spec 61): entidade privada sai (AND e.private = 0) e o EXISTS de
  // observações ignora observação privada (AND ev.private = 0) — senão o conteúdo de
  // observação privada num contato público vazaria por inferência na busca.
  const privE = includePrivate ? "" : "AND e.private = 0";
  const privEv = includePrivate ? "" : "AND ev.private = 0";
  // 6 LIKEs de campos de entidade + 1 LIKE do EXISTS em events.context (spec 60 §4).
  const binds: any[] = [like, like, like, like, like, like, like];
  if (kindFilter) binds.push(kindFilter);
  if (categoryFilter) binds.push(categoryFilter);
  binds.push(limit);
  const results = await env.DB.prepare(
    // Busca textual também alcança observações datadas (events.context) via EXISTS
    // correlacionado (spec 60 §4).
    `SELECT e.id, e.kind, e.name, e.phone, e.email, e.role, e.company, e.website, e.sector, e.source, e.last_contacted, e.category
       FROM entities e
      WHERE (LOWER(e.name) LIKE ? OR LOWER(COALESCE(e.email,'')) LIKE ? OR LOWER(COALESCE(e.role,'')) LIKE ?
             OR LOWER(COALESCE(e.company,'')) LIKE ? OR LOWER(COALESCE(e.sector,'')) LIKE ? OR LOWER(COALESCE(e.notes_text,'')) LIKE ?
             OR EXISTS (SELECT 1 FROM events ev WHERE ev.entity_id = e.id
                        AND LOWER(COALESCE(ev.context,'')) LIKE ? ${privEv}))
        ${kindSql} ${catSql} ${rawSql} ${privE}
      ORDER BY e.last_contacted DESC NULLS LAST
      LIMIT ?`
  ).bind(...binds).all();
  return json({ ok: true, query: q, mode: "sql_like", count: results.results?.length ?? 0, results: results.results });
}

// Lookup DETERMINÍSTICO por telefone (match exato, não semântico). Tenta as
// variantes com/sem 9º dígito e devolve o match exato primeiro.
async function handleContactByPhone(url: URL, env: Env, req: Request): Promise<Response> {
  // Privacidade (spec 61): lookup por telefone é um GET que devolve o contato — a
  // entidade privada não resolve pra quem não vê privados (nem pela coluna, nem pelo
  // canal secundário). Fail-closed igual às demais superfícies de leitura.
  const includePrivate = await callerSeesPrivate(req, env);
  const privE = includePrivate ? "" : " AND private = 0";
  const privCh = includePrivate ? "" : " AND e.private = 0";
  const raw = url.searchParams.get("phone") || "";
  const base = normalizePhone(raw);
  if (!base) return err(400, "phone required (E.164 sem +, ex: 5511987654321)");
  const list = phoneVariants(base);
  if (!list.length) list.push(base);
  const ph = list.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `SELECT id, kind, name, phone, email, role, company, website, sector, source, category, avatar_r2_key
       FROM entities WHERE phone IN (${ph})${privE} ORDER BY (phone = ?) DESC LIMIT 10`
  ).bind(...list, base).all();
  const results = r.results || [];
  if (results.length > 0) {
    return json({ ok: true, query: raw, normalized: base, variants: list, count: results.length, match: results[0], results });
  }
  // Fallback (spec 55): não achou na coluna → procura em entity_channels kind 'phone'
  // (telefone SECUNDÁRIO), com as mesmas variantes de 9º dígito. Resolve o contato
  // por qualquer telefone da cartela, não só o primário espelhado na coluna.
  const cr = await env.DB.prepare(
    `SELECT e.id, e.kind, e.name, e.phone, e.email, e.role, e.company, e.website, e.sector, e.source, e.category, e.avatar_r2_key,
            ch.value AS matched_channel
       FROM entity_channels ch
       JOIN entities e ON e.id = ch.entity_id
      WHERE ch.kind = 'phone' AND ch.value IN (${ph})${privCh}
      ORDER BY (ch.value = ?) DESC LIMIT 10`
  ).bind(...list, base).all();
  const cres = cr.results || [];
  return json({
    ok: true, query: raw, normalized: base, variants: list,
    count: cres.length, match: cres[0] || null, results: cres,
    matched_via: cres.length ? "channel" : "none",
  });
}

async function handleConnect(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  // aceita a_id/b_id (preferido) ou person_a/person_b (back-compat)
  const rawA = body.a_id || body.person_a;
  const rawB = body.b_id || body.person_b;
  if (!rawA || !rawB) return err(400, "a_id and b_id required");
  if (rawA === rawB) return err(400, "a_id and b_id must differ");
  if (!body.type) return err(400, "type required");
  if (!CONN_TYPES_SET.has(body.type)) return err(400, `invalid type: ${body.type}`, { allowed: [...CONN_TYPES] });
  if (typeof body.strength !== "number" || body.strength < 0 || body.strength > 1)
    return err(400, "strength must be between 0 and 1");
  if (!body.why || body.why.length < 20)
    return err(400, "why must be at least 20 chars (explain the shared mechanism)");

  // tipos simétricos: ordena o par pra que connect(B,A,'friend') colida no
  // UNIQUE(a_id,b_id,type) com connect(A,B,'friend') e devolva 409 (spec 19 §5).
  const [a, b] = normalizeConnPair(rawA, rawB, body.type);

  const both = await env.DB.prepare("SELECT id FROM entities WHERE id IN (?, ?)").bind(a, b).all();
  if ((both.results?.length ?? 0) !== 2) return err(404, "one or both entities not found");

  const id = uuid();
  try {
    await env.DB.prepare(
      `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, a, b, body.type, body.strength, body.why).run();
  } catch (e: any) {
    if (String(e?.message || e).includes("UNIQUE")) return err(409, "connection already exists (same a,b,type)");
    if (String(e?.message || e).includes("CHECK")) return err(400, "check constraint failed");
    throw e;
  }
  return json({ ok: true, id, edge: { a_id: a, b_id: b, type: body.type } });
}

// Fina camada REST sobre o núcleo compartilhado recordEvent (src/events.ts) — MESMA
// validação/insert/last_contacted/reembed que o Console (spec 50-console-v2/57).
// Mantém EXATAMENTE o formato de resposta anterior (err() com `detail.allowed`) pra
// não quebrar consumidores existentes (MCP standalone, testes).
async function handleEvent(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  const entityId = body.entity_id || body.person_id;
  const result = await recordEvent(
    env,
    { entity_id: entityId, kind: body.kind, context: body.context, ts: body.ts, source: body.source, private: body.private === true },
    ctx,
  );
  switch (result.status) {
    case "missing_fields":
      return err(400, "entity_id and kind required");
    case "invalid_kind":
      return err(400, `invalid kind: ${body.kind}`, { allowed: [...result.allowed] });
    case "invalid_source":
      return err(400, `invalid source: ${body.source}`, { allowed: [...result.allowed] });
    case "not_found":
      return err(404, "entity not found");
    case "ok":
      return json({ ok: true, id: result.id });
    default:
      // Inalcançável — RecordEventResult é união fechada; guarda de exaustividade.
      return err(500, "unexpected recordEvent status", { status: (result as { status: string }).status });
  }
}

async function handleAttachMedia(req: Request, env: Env): Promise<Response> {
  if (!env.MEDIA) return err(503, "R2 bucket not configured (MEDIA binding missing)");
  let body: any;
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  const entityId = body.entity_id || body.person_id;
  if (!entityId) return err(400, "entity_id required");
  if (!body.base64) return err(400, "base64 payload required");
  const mime = body.mime_type || "application/octet-stream";
  const kind = body.kind || (mime.startsWith("image/") ? "avatar" : "other");

  const ent = await env.DB.prepare("SELECT id FROM entities WHERE id = ?").bind(entityId).first();
  if (!ent) return err(404, "entity not found");

  let bytes: Uint8Array;
  try { bytes = base64ToBytes(body.base64); } catch { return err(400, "base64 decode failed"); }
  if (bytes.length === 0) return err(400, "empty payload");
  if (bytes.length > 10 * 1024 * 1024) return err(413, "media > 10MB not supported");

  const hash = await sha256Hex(bytes);
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp"
    : mime === "audio/ogg" ? "ogg" : mime === "audio/mpeg" ? "mp3" : "bin";
  const r2Key = `sha256/${hash}.${ext}`;

  const existingObj = await env.MEDIA.head(r2Key);
  if (!existingObj) await env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mime } });

  // dedup no D1: mesma entidade + mesmo conteúdo não cria linha nova (o R2 já
  // deduplicava só o blob; o INSERT rodava sempre e duplicava linhas). Mesmo
  // conteúdo em OUTRA entidade continua criando linha — a mídia pertence ao
  // vínculo (spec 19 §7). `deduped` passa a significar "linha já existia p/ ESTA
  // entidade" (não só o blob no R2).
  const dupRow = await env.DB.prepare(
    "SELECT id FROM media WHERE entity_id = ? AND content_hash = ? LIMIT 1"
  ).bind(entityId, hash).first<{ id: string }>();
  if (dupRow) {
    // honra set_as_avatar (idempotente) antes de retornar
    if (body.set_as_avatar || kind === "avatar") {
      await env.DB.prepare("UPDATE entities SET avatar_r2_key = ? WHERE id = ?").bind(r2Key, entityId).run();
    }
    return json({ ok: true, id: dupRow.id, content_hash: hash, r2_key: r2Key, byte_size: bytes.length, deduped: true, url: `/media/${hash}` });
  }

  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO media (id, entity_id, kind, r2_key, content_hash, mime_type, byte_size, caption)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, entityId, kind, r2Key, hash, mime, bytes.length, body.caption ?? null).run();

  if (body.set_as_avatar || kind === "avatar") {
    await env.DB.prepare("UPDATE entities SET avatar_r2_key = ? WHERE id = ?").bind(r2Key, entityId).run();
  }
  return json({ ok: true, id, content_hash: hash, r2_key: r2Key, byte_size: bytes.length, deduped: !!existingObj, url: `/media/${hash}` });
}

async function handleListEntities(url: URL, env: Env, req: Request, forcedKind?: string): Promise<Response> {
  // Privacidade (spec 61): entidade privada some da listagem pra quem não vê privados.
  const includePrivate = await callerSeesPrivate(req, env);
  const kind = forcedKind || url.searchParams.get("kind");
  const category = url.searchParams.get("category");
  const hasPhone = url.searchParams.get("has_phone") === "true";
  const noAvatar = url.searchParams.get("no_avatar") === "true";
  // imports crus (name = número, sem letra) escondidos por padrão; include_raw=true mostra
  // (a auditoria/curadoria jwt0cs5k94yd usa include_raw pra enxergar os crus).
  const includeRaw = url.searchParams.get("include_raw") === "true";
  const limit = parseIntSafe(url.searchParams.get("limit"), 500, 0, 1000);
  const offset = parseIntSafe(url.searchParams.get("offset"), 0, 0);

  const where: string[] = [];
  const binds: any[] = [];
  if (kind) { where.push("kind = ?"); binds.push(kind); }
  if (category) { where.push("category = ?"); binds.push(category); }
  // sem filtro explícito, 'mapeado' fica fora da listagem (default-off — canon.ts)
  else where.push(`COALESCE(category,'') != '${HIDDEN_BY_DEFAULT_CATEGORY}'`);
  if (hasPhone) where.push("phone IS NOT NULL");
  if (noAvatar) where.push("avatar_r2_key IS NULL");
  if (!includeRaw) where.push("name GLOB '*[A-Za-z]*'");
  if (!includePrivate) where.push("private = 0");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  binds.push(limit, offset);

  const r = await env.DB.prepare(
    `SELECT id, kind, name, phone, email, role, company, website, sector, source, category, avatar_r2_key
       FROM entities ${whereSql} ORDER BY name LIMIT ? OFFSET ?`
  ).bind(...binds).all();
  return json({ ok: true, count: r.results?.length ?? 0, results: r.results });
}

// Grafo pro front: arestas + os nós envolvidos. Opcional ?include=all&limit= p/ amostra de nós isolados.
// 'mapeado' fica fora do grafo (default-off): o nó some E as arestas que o tocam
// caem junto — senão a aresta apontaria pra nó fantasma.
async function handleGraphData(url: URL, env: Env): Promise<Response> {
  const edgesR = await env.DB.prepare(
    `SELECT c.id, c.a_id, c.b_id, c.type, c.strength, c.why FROM connections c LIMIT 5000`
  ).all();
  let edges = edgesR.results || [];
  const nodeIds = new Set<string>();
  for (const e of edges as any[]) { nodeIds.add(e.a_id); nodeIds.add(e.b_id); }

  const includeAll = url.searchParams.get("include") === "all";
  const sampleLimit = Math.min(parseInt(url.searchParams.get("limit") || "0") || 0, 2000);

  let nodes: any[] = [];
  if (nodeIds.size) {
    const ids = [...nodeIds];
    const ph = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id, kind, name, company, sector, avatar_r2_key FROM entities
        WHERE id IN (${ph}) AND COALESCE(category,'') != '${HIDDEN_BY_DEFAULT_CATEGORY}'`
    ).bind(...ids).all();
    nodes = r.results || [];
    const visible = new Set(nodes.map((n) => n.id));
    edges = (edges as any[]).filter((e) => visible.has(e.a_id) && visible.has(e.b_id));
  }
  if (includeAll && sampleLimit) {
    const extra = await env.DB.prepare(
      `SELECT id, kind, name, company, sector, avatar_r2_key FROM entities
        WHERE COALESCE(category,'') != '${HIDDEN_BY_DEFAULT_CATEGORY}'
        ORDER BY last_contacted DESC NULLS LAST LIMIT ?`
    ).bind(sampleLimit).all();
    const have = new Set(nodes.map((n) => n.id));
    for (const n of (extra.results || []) as any[]) if (!have.has(n.id)) nodes.push(n);
  }
  return json({ ok: true, node_count: nodes.length, edge_count: edges.length, nodes, edges });
}

async function handleReembedAll(req: Request, env: Env): Promise<Response> {
  if (!env.VECTORIZE) return err(503, "VECTORIZE binding not configured");
  const url = new URL(req.url);
  const offset = parseIntSafe(url.searchParams.get("offset"), 0, 0);
  const limit = parseIntSafe(url.searchParams.get("limit"), 30, 0, 50);

  const totalRow = await env.DB.prepare("SELECT COUNT(*) as n FROM entities").first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const page = await env.DB.prepare(
    "SELECT id, kind, name, role, company, sector, website, notes_text, source, category FROM entities ORDER BY id LIMIT ? OFFSET ?"
  ).bind(limit, offset).all<any>();

  const batch: VectorizeVector[] = [];
  const emptyIds: string[] = [];
  let failed = 0;
  for (const e of page.results || []) {
    // Mesma composição do reembed incremental: identidade + observações datadas
    // (events kind='note'), fonte única observationsTextFor (spec 60 §1/§3).
    const observations = await observationsTextFor(env, e.id);
    const text = embeddingTextFor({ ...e, observations });
    // Sem substância além do nome (nome fora do vetor, 10/07/2026): sai do índice —
    // sem isto o vetor antigo baseado em nome ficaria stale gerando Similares por grafia.
    if (!text.trim()) { emptyIds.push(e.id); continue; }
    const vec = await computeEmbedding(env, text);
    if (!vec) { failed++; continue; }
    batch.push({ id: e.id, values: vec, metadata: vectorMetadataFor(e, text) });
  }
  let upserted = 0;
  if (batch.length) {
    try { await env.VECTORIZE.upsert(batch); upserted = batch.length; }
    catch (e: any) { return err(500, "vectorize upsert failed", String(e?.message || e)); }
  }
  // Remoção em lote dos sem-substância: 1 deleteByIds + N limpezas de similar_edges.
  let cleared = 0;
  if (emptyIds.length) {
    try {
      await env.VECTORIZE.deleteByIds(emptyIds);
    } catch (e: any) {
      console.error("[setup/reembed] deleteByIds failed", e?.message || e);
    }
    for (const id of emptyIds) {
      try { await replaceSimilarEdges(env, id, []); cleared++; }
      catch (e: any) { console.error("[setup/reembed] clear edges failed", id, e?.message || e); }
    }
  }
  // Recomputa as similar edges das entidades reembedadas (spec 21 §1c) usando o vetor
  // em mãos (batch) — sem re-query. Cada uma em try/catch: vizinho órfão viola FK e não
  // pode abortar o lote. Orçamento: N×(1 query + 1 batch) ≤ 50×2 = 100 subrequests +
  // N embeddings + 1 upsert; cabe com folga sob o cap do plano pago (limit ≤ 50).
  let sim_edges = 0, sim_failed = 0;
  for (const v of batch) {
    try {
      sim_edges += await refreshSimilarEdges(env, v.id, Array.from(v.values), { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    } catch (e: any) {
      sim_failed++;
      console.error("[setup/reembed] refreshSimilarEdges failed", v.id, e?.message || e);
    }
  }
  const nextOffset = offset + (page.results?.length ?? 0);
  return json({ ok: true, total, page_processed: page.results?.length ?? 0, upserted, cleared, failed, sim_edges, sim_failed, next_offset: nextOffset < total ? nextOffset : null });
}

// Backfill resumível das similar edges das entidades que já existiam ANTES desta
// feature. UM lote por chamada (cursor por id) pra caber no cap de subrequests — o
// cliente chama em loop passando ?after=<cursor> até done:true. Porta de
// handleBackfillSimilar do Brain (src/auth/setup.ts). Idempotente (replaceSimilarEdges
// sobrescreve). Orçamento por lote: 1 getByIds + N×(1 query + 1 batch) = 1 + 2N ≤ 41
// (limit clampeado em 20) — cabe até no free tier. NÃO relaxar o teto sem refazer a conta.
// Auth: mesmo Bearer OWNER_TOKEN das demais /setup/* (requireAuth no router).
// Gate: rodar em produção SÓ com OK do dono (custa quota Vectorize/Workers AI).
async function handleBackfillSimilar(req: Request, env: Env): Promise<Response> {
  if (!env.VECTORIZE) return err(503, "VECTORIZE binding not configured");
  const url = new URL(req.url);
  const after = url.searchParams.get("after") ?? "";
  const limit = parseIntSafe(url.searchParams.get("limit"), 20, 1, 20);

  // Próximas entidades após o cursor, ordenadas por id (PK estável e resumível).
  const rows = await env.DB.prepare(
    `SELECT id FROM entities WHERE id > ? ORDER BY id LIMIT ?`
  ).bind(after, limit).all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  if (ids.length === 0) {
    return json({ ok: true, done: true, processed: 0, edges: 0, missing: 0, failed: 0, cursor: after });
  }

  // Busca os vetores já indexados (getByIds tem cap de 20 ids/call).
  const vecById = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const vs = await env.VECTORIZE.getByIds(chunk);
    for (const v of vs) if (v.values) vecById.set(v.id, Array.from(v.values));
  }

  let processed = 0, edges = 0, missing = 0, failed = 0;
  for (const id of ids) {
    const vec = vecById.get(id);
    if (!vec) { missing++; continue; } // vetor ainda não indexado — próxima passada pega
    // try/catch CRÍTICO: se refreshSimilarEdges lançar (vizinho órfão viola FK e o batch
    // aborta), NÃO deixamos o handler dar 500 — senão o cursor nunca avança e o backfill
    // TRAVA pra sempre. A entidade problemática é contada em `failed` e pulada.
    try {
      edges += await refreshSimilarEdges(env, id, vec, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
      processed++;
    } catch (e: any) {
      failed++;
      console.error("[setup/backfill-similar] refreshSimilarEdges failed", id, e?.message || e);
    }
  }
  return json({ ok: true, done: false, processed, edges, missing, failed, cursor: ids[ids.length - 1] });
}

// --------- router ---------
// ─────────────────── Cron de manutenção (sync incremental do CRM) ───────────────────
// 1x/dia puxa do Pipedrive as pessoas modificadas desde o último run e preenche
// SOMENTE campos vazios de contatos que JÁ existem (não importa novos). Re-embeda
// quando muda `company` (campo que entra no vetor); email não afeta o vetor.
// Resultado discriminado (spec 10-backend/22): {ok:false} = 401/429/5xx/rede e
// NUNCA pode avançar a janela; {ok:true, data.data:[]} = "sem resultados"
// legítimo. Token vai no header x-api-token — na querystring ele vazava em logs
// de URL (e a observability do Worker está ligada).
type PdResult = { ok: true; data: any } | { ok: false; status: number };

async function pdGet(env: Env, path: string): Promise<PdResult> {
  try {
    const r = await fetch(`https://api.pipedrive.com/v1${path}`, {
      headers: { "x-api-token": env.PIPEDRIVE_API_KEY! },
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, status: 0 }; // erro de rede
  }
}

// Delega pra fonte ÚNICA (entity-write.ts) — mesma lógica de embedding/metadata que
// handleSaveEntity e o endpoint do Console usam. Mantém a assinatura void usada
// pelo cron de manutenção (handleMaintenanceSync).
async function reembedEntity(env: Env, id: string): Promise<void> {
  const reembed = await reembedEntityShared(env, id, {
    embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor,
  });
  // Mantém as similar edges frescas após o reembed do cron (spec 21 §1c) — não-fatal.
  if (reembed.vector) {
    try {
      await refreshSimilarEdges(env, id, reembed.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    } catch (e: any) {
      console.error("[reembedEntity] refreshSimilarEdges failed", id, e?.message || e);
    }
  }
}

// Processa UMA person do /recents: enriquecimento só-preenche-vazios de contato
// que já existe (match por telefone). Retorna o que aconteceu pros contadores.
async function maintProcessPerson(env: Env, p: any): Promise<{ enriched: boolean; reembedded: boolean }> {
  const phoneRaw = Array.isArray(p.phone) ? (p.phone.find((x: any) => x.value)?.value) : null;
  const phone = normalizePhone(phoneRaw);
  if (!phone) return { enriched: false, reembedded: false };
  const emails = Array.isArray(p.email) ? p.email.map((x: any) => x.value).filter(Boolean) : [];
  const email = emails.find((e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/@(c\.us|lid|s\.whatsapp\.net|g\.us)$/i.test(e) && !/^\d{8,}@/.test(e)) || null;
  const org = p.org_id?.name || null;
  const variants = phoneVariants(phone);
  if (!variants.length) return { enriched: false, reembedded: false };
  const ph = variants.map(() => "?").join(",");
  const ex = await env.DB.prepare(`SELECT id, email, company FROM entities WHERE phone IN (${ph}) LIMIT 1`).bind(...variants).first<any>();
  if (!ex) return { enriched: false, reembedded: false }; // manutenção: só atualiza quem já existe
  const sets: string[] = [], binds: any[] = [];
  let companyChanged = false;
  if (!ex.email && email) { sets.push("email = ?"); binds.push(email); }
  if (!ex.company && org) { sets.push("company = ?"); binds.push(org); companyChanged = true; }
  if (!sets.length) return { enriched: false, reembedded: false };
  binds.push(ex.id);
  await env.DB.prepare(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  if (companyChanged) { await reembedEntity(env, ex.id); }
  return { enriched: true, reembedded: companyChanged };
}

// Sync incremental robusto (spec 10-backend/22):
// - `since` = timestamp de INÍCIO do run (janela seguinte sobrepõe, nunca fura;
//   sobreposição é segura porque o sync é idempotente — só preenche vazios).
// - Erro HTTP/rede em qualquer página: aborta SEM gravar maint:last_run (a
//   janela repete no próximo run) e incrementa o contador de falhas.
// - Teto de trabalho por invocação (MAINT_MAX_PERSONS, default 500): ao atingir,
//   grava checkpoint em maint:cursor e retorna partial:true; o próximo run
//   retoma do next_start. maint:last_run só avança com a janela DRENADA.
const MAINT_MAX_PERSONS_DEFAULT = 500;

export async function handleMaintenanceSync(env: Env): Promise<any> {
  if (!env.PIPEDRIVE_API_KEY) return { ok: false, error: "PIPEDRIVE_API_KEY ausente (secret não configurado)" };
  const maxPersons = parseInt(env.MAINT_MAX_PERSONS ?? "", 10) || MAINT_MAX_PERSONS_DEFAULT;

  // Retomada: cursor pendente = janela anterior ainda não drenada.
  let cursor: { since: string; run_started_at: string; next_start: number } | null = null;
  try {
    const raw = await env.CACHE.get("maint:cursor");
    if (raw) cursor = JSON.parse(raw);
  } catch { cursor = null; }

  const runStartedAt = cursor?.run_started_at ?? new Date().toISOString().slice(0, 19).replace("T", " ");
  const last = await env.CACHE.get("maint:last_run");
  const since = cursor?.since ?? (last || new Date(Date.now() - 26 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "));

  let start = cursor?.next_start ?? 0;
  let more = true, pagesOk = 0;
  let scanned = 0, enriched = 0, reembed = 0;

  while (more && scanned < maxPersons) {
    const res = await pdGet(env, `/recents?since_timestamp=${encodeURIComponent(since)}&items=person&start=${start}&limit=100`);
    if (!res.ok) {
      // NÃO grava last_run nem mexe no cursor: a mesma janela re-tenta no
      // próximo disparo. Falha vira contador + maint:alert (spec 40-ops/43).
      await trackMaintOutcome(env, false, `pipedrive_http_error status=${res.status} since=${since} pages_ok=${pagesOk}`);
      return { ok: false, error: "pipedrive_http_error", status: res.status, since, pages_ok: pagesOk };
    }
    pagesOk++;
    // Processa a página INTEIRA antes de avançar o offset — um teto no meio da
    // página gravaria next_start da página seguinte e pularia o resto dela.
    for (const it of (res.data?.data || [])) {
      if (it.item !== "person" || !it.data) continue;
      scanned++;
      const r = await maintProcessPerson(env, it.data);
      if (r.enriched) enriched++;
      if (r.reembedded) reembed++;
    }
    more = !!res.data?.additional_data?.pagination?.more_items_in_collection;
    start = res.data?.additional_data?.pagination?.next_start || 0;
  }

  if (more) {
    await env.CACHE.put("maint:cursor", JSON.stringify({ since, run_started_at: runStartedAt, next_start: start }));
    return { ok: true, partial: true, processed: scanned, next_start: start, since };
  }
  await env.CACHE.delete("maint:cursor");
  await env.CACHE.put("maint:last_run", runStartedAt);
  await trackMaintOutcome(env, true);
  return { ok: true, since, persons_recentes: scanned, escaneados: scanned, enriquecidos: enriched, reembedded: reembed, ranAt: runStartedAt };
}

// GET /pipedrive/status — visão pro painel do Brain (mesmo molde do /whatsapp/status):
// a integração com o CRM é OPCIONAL (só existe se o dono configurou o secret
// PIPEDRIVE_API_KEY). Expõe o estado do sync incremental sem nenhuma credencial.
async function handlePipedriveStatus(env: Env): Promise<Response> {
  let lastRun: string | null = null;
  let failures = 0;
  let cursorPending = false;
  try {
    const [lr, cf, cursor] = await Promise.all([
      env.CACHE.get("maint:last_run"),
      env.CACHE.get("maint:consecutive_failures"),
      env.CACHE.get("maint:cursor"),
    ]);
    lastRun = lr;
    failures = parseInt(cf ?? "0", 10) || 0;
    cursorPending = !!cursor;
  } catch { /* KV transiente: status responde com defaults */ }
  return json({
    ok: true,
    configured: !!env.PIPEDRIVE_API_KEY,
    last_run: lastRun,
    consecutive_failures: failures,
    cursor_pending: cursorPending,
  });
}

// --------- operações destrutivas (spec 30-features/34) ---------
// Delete de contacts é HARD (sem lixeira/undelete), diferente do Brain: o vault é
// majoritariamente derivado de fontes re-importáveis (WhatsApp/Pipedrive) — o custo
// de re-importar é menor que carregar soft-delete em toda query. Mitigações:
// confirm obrigatório, só OWNER_TOKEN (proxy read-only nunca passa), log
// [destructive] auditável no observability, backup do D1 antes do primeiro uso.

function confirmRequired(url: URL): Response | null {
  if (url.searchParams.get("confirm") === "true") return null;
  return err(400, "confirm=true required (operação destrutiva e irreversível)");
}

// Remove o vetor no Vectorize — não-fatal (D1 já deletou; falha entra no report
// pra retry manual e o hydrate do recall descarta matches sem linha no D1).
async function deleteVector(env: Env, id: string): Promise<boolean> {
  if (!env.VECTORIZE) return false;
  try {
    await env.VECTORIZE.deleteByIds([id]);
    return true;
  } catch (e: any) {
    console.error("[destructive] vectorize deleteByIds falhou", id, e?.message || e);
    return false;
  }
}

async function handleDeleteEntity(id: string, url: URL, env: Env): Promise<Response> {
  const confirmErr = confirmRequired(url);
  if (confirmErr) return confirmErr;

  const entity = await env.DB.prepare("SELECT id, kind, name FROM entities WHERE id = ?").bind(id).first<any>();
  if (!entity) return err(404, "entity not found");

  // Contadores + r2_keys ANTES do delete (o CASCADE limpa as linhas dependentes).
  const [conns, events, media, channels, r2rows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) n FROM connections WHERE a_id = ? OR b_id = ?").bind(id, id).first<any>(),
    env.DB.prepare("SELECT COUNT(*) n FROM events WHERE entity_id = ?").bind(id).first<any>(),
    env.DB.prepare("SELECT COUNT(*) n FROM media WHERE entity_id = ?").bind(id).first<any>(),
    env.DB.prepare("SELECT COUNT(*) n FROM entity_channels WHERE entity_id = ?").bind(id).first<any>(),
    env.DB.prepare("SELECT DISTINCT r2_key FROM media WHERE entity_id = ?").bind(id).all<any>(),
  ]);

  await env.DB.prepare("DELETE FROM entities WHERE id = ?").bind(id).run();
  const vectorizeDeleted = await deleteVector(env, id);

  // Blob R2 só morre quando o refcount zera — o blob é deduplicado por hash e
  // pode ser referenciado por media de OUTRAS entidades.
  let r2Deleted = 0;
  for (const row of r2rows.results ?? []) {
    const key = (row as any).r2_key as string;
    try {
      const still = await env.DB.prepare("SELECT COUNT(*) n FROM media WHERE r2_key = ?").bind(key).first<any>();
      if ((still?.n ?? 0) === 0 && env.MEDIA) {
        await env.MEDIA.delete(key);
        r2Deleted++;
      }
    } catch (e: any) {
      console.error("[destructive] limpeza R2 falhou", key, e?.message || e);
    }
  }

  const cascade = { connections: conns?.n ?? 0, events: events?.n ?? 0, media: media?.n ?? 0, channels: channels?.n ?? 0 };
  console.log("[destructive]", JSON.stringify({
    op: "delete_entity", id, kind: entity.kind, name: entity.name,
    ...cascade, r2_deleted: r2Deleted, vectorize_deleted: vectorizeDeleted, ts: new Date().toISOString(),
  }));
  return json({ ok: true, deleted: { id, kind: entity.kind, name: entity.name }, cascade, vectorize_deleted: vectorizeDeleted, r2_blobs_deleted: r2Deleted });
}

async function handleDeleteConnection(id: string, url: URL, env: Env): Promise<Response> {
  const confirmErr = confirmRequired(url);
  if (confirmErr) return confirmErr;

  const conn = await env.DB.prepare("SELECT id, a_id, b_id, type FROM connections WHERE id = ?").bind(id).first<any>();
  if (!conn) return err(404, "connection not found");

  await env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(id).run();
  console.log("[destructive]", JSON.stringify({ op: "delete_connection", ...conn, ts: new Date().toISOString() }));
  return json({ ok: true, deleted: conn });
}

// Campos que o merge preenche no vencedor quando estão NULL nele e não-NULL no
// perdedor (COALESCE — vencedor SEMPRE prevalece quando tem valor; name NUNCA muda).
const MERGE_FILL_FIELDS = [
  "phone", "email", "role", "company", "website", "sector", "birthday",
  "notes_text", "attributes", "category", "avatar_r2_key",
] as const;

async function handleMergeEntities(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, "invalid json body"); }
  const { winner_id, loser_id } = body ?? {};
  if (body?.confirm !== true) return err(400, "confirm:true required (operação destrutiva e irreversível)");
  if (!winner_id || !loser_id) return err(400, "winner_id e loser_id são obrigatórios");
  if (winner_id === loser_id) return err(400, "winner_id e loser_id não podem ser iguais");

  const winner = await env.DB.prepare("SELECT * FROM entities WHERE id = ?").bind(winner_id).first<any>();
  if (!winner) return err(404, "winner not found");
  const loser = await env.DB.prepare("SELECT * FROM entities WHERE id = ?").bind(loser_id).first<any>();
  if (!loser) return err(404, "loser not found");
  if (winner.kind !== loser.kind) {
    return err(400, `kinds diferem (${winner.kind} vs ${loser.kind}); merge só entre entidades do mesmo kind`);
  }

  // 1. Re-apontar as connections do perdedor, deduplicando contra o
  //    UNIQUE(a_id, b_id, type). Checagem em JS (não parse de erro de UNIQUE):
  //    set das arestas do vencedor + pares já produzidos neste loop.
  const winnerConns = await env.DB.prepare("SELECT a_id, b_id, type FROM connections WHERE a_id = ? OR b_id = ?").bind(winner_id, winner_id).all<any>();
  const seen = new Set<string>();
  for (const c of winnerConns.results ?? []) seen.add(`${c.a_id}|${c.b_id}|${c.type}`);

  const loserConns = await env.DB.prepare("SELECT id, a_id, b_id, type FROM connections WHERE a_id = ? OR b_id = ?").bind(loser_id, loser_id).all<any>();
  const stmts: D1PreparedStatement[] = [];
  let connectionsMoved = 0, connectionsDeduped = 0, connectionsDroppedSelfloop = 0;
  for (const c of loserConns.results ?? []) {
    const a = c.a_id === loser_id ? winner_id : c.a_id;
    const b = c.b_id === loser_id ? winner_id : c.b_id;
    if (a === b) {
      // aresta winner<->loser viraria self-loop
      stmts.push(env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(c.id));
      connectionsDroppedSelfloop++;
      continue;
    }
    const key = `${a}|${b}|${c.type}`;
    const mirror = `${b}|${a}|${c.type}`;
    const dup = seen.has(key) || (SYMMETRIC_CONN_TYPES.includes(c.type) && seen.has(mirror));
    if (dup) {
      stmts.push(env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(c.id));
      connectionsDeduped++;
    } else {
      stmts.push(env.DB.prepare("UPDATE connections SET a_id = ?, b_id = ? WHERE id = ?").bind(a, b, c.id));
      seen.add(key);
      connectionsMoved++;
    }
  }

  // Contadores pré-batch dos dependentes restantes do perdedor.
  const [evCount, mdCount, chCount] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) n FROM events WHERE entity_id = ?").bind(loser_id).first<any>(),
    env.DB.prepare("SELECT COUNT(*) n FROM media WHERE entity_id = ?").bind(loser_id).first<any>(),
    env.DB.prepare("SELECT COUNT(*) n FROM entity_channels WHERE entity_id = ?").bind(loser_id).first<any>(),
  ]);

  // Campos que o COALESCE vai preencher (calculado ANTES do batch, pro report).
  const fieldsFilled = MERGE_FILL_FIELDS.filter(
    (f) => (winner[f] === null || winner[f] === undefined || winner[f] === "") && loser[f] !== null && loser[f] !== undefined && loser[f] !== ""
  );

  // 2-6. Um único batch (autocommit-transacional no D1): move eventos/mídia/canais,
  // deleta o perdedor e SÓ DEPOIS preenche o vencedor (libera o phone do perdedor
  // antes do COALESCE — dedupe lógico por telefone do save_person). Canais que
  // violariam o UNIQUE(entity_id, kind, value) ficam no perdedor (UPDATE OR IGNORE)
  // e morrem no CASCADE do delete — dedupe de graça.
  stmts.push(
    env.DB.prepare("UPDATE events SET entity_id = ? WHERE entity_id = ?").bind(winner_id, loser_id),
    env.DB.prepare("UPDATE media SET entity_id = ? WHERE entity_id = ?").bind(winner_id, loser_id),
    env.DB.prepare("UPDATE OR IGNORE entity_channels SET entity_id = ? WHERE entity_id = ?").bind(winner_id, loser_id),
    env.DB.prepare("DELETE FROM entities WHERE id = ?").bind(loser_id),
    env.DB.prepare(
      `UPDATE entities SET
         phone          = COALESCE(phone, ?),
         email          = COALESCE(email, ?),
         role           = COALESCE(role, ?),
         company        = COALESCE(company, ?),
         website        = COALESCE(website, ?),
         sector         = COALESCE(sector, ?),
         birthday       = COALESCE(birthday, ?),
         notes_text     = COALESCE(notes_text, ?),
         attributes     = COALESCE(attributes, ?),
         category       = COALESCE(category, ?),
         avatar_r2_key  = COALESCE(avatar_r2_key, ?),
         last_contacted = CASE
           WHEN last_contacted IS NULL THEN ?
           WHEN ? IS NULL THEN last_contacted
           ELSE MAX(last_contacted, ?) END
       WHERE id = ?`
    ).bind(
      loser.phone ?? null, loser.email ?? null, loser.role ?? null, loser.company ?? null,
      loser.website ?? null, loser.sector ?? null, loser.birthday ?? null, loser.notes_text ?? null,
      loser.attributes ?? null, loser.category ?? null, loser.avatar_r2_key ?? null,
      loser.last_contacted ?? null, loser.last_contacted ?? null, loser.last_contacted ?? null,
      winner_id
    ),
    // Trilha permanente no vencedor, consultável via GET /entities/:id.
    env.DB.prepare(
      "INSERT INTO events (id, entity_id, kind, context, source) VALUES (?, ?, 'merged_from', ?, 'merge')"
    ).bind(uuid(), winner_id, `merged loser ${loser_id} ("${loser.name}")`),
  );
  await env.DB.batch(stmts);

  const loserVectorDeleted = await deleteVector(env, loser_id);

  // 7. Re-embedar o vencedor (campos preenchidos mudam o texto) + similar edges
  // frescas — não-fatal, mesmo padrão do write path.
  let winnerReembedded = false;
  try {
    const reembed = await reembedEntityShared(env, winner_id, {
      embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor,
    });
    winnerReembedded = reembed.action === "upserted";
    if (reembed.vector) {
      await refreshSimilarEdges(env, winner_id, reembed.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    }
  } catch (e: any) {
    console.error("[merge] reembed/similar do vencedor falhou (não-fatal)", winner_id, e?.message || e);
  }

  // 8. Write-back Google (não-fatal): o merge escreve identidade FORA do caminho
  // canônico (batch acima), então o enqueue é explícito aqui. Só os campos de
  // identidade que o COALESCE pode ter preenchido; os gates (toggle/scope/link)
  // ficam dentro do maybeEnqueue.
  try {
    const enq = await maybeEnqueueGooglePush(env, winner_id, {
      phone: loser.phone ?? null, email: loser.email ?? null, role: loser.role ?? null,
      company: loser.company ?? null, birthday: loser.birthday ?? null,
    });
    if (enq) await tryGooglePushNow(env, winner_id);
  } catch (e: any) {
    console.error("[merge] write-back enqueue falhou (não-fatal)", winner_id, e?.message || e);
  }

  const report = {
    connections_moved: connectionsMoved,
    connections_deduped: connectionsDeduped,
    connections_dropped_selfloop: connectionsDroppedSelfloop,
    events_moved: evCount?.n ?? 0,
    media_moved: mdCount?.n ?? 0,
    channels_moved: chCount?.n ?? 0,
    fields_filled: fieldsFilled,
    vectorize: { loser_deleted: loserVectorDeleted, winner_reembedded: winnerReembedded },
  };
  console.log("[destructive]", JSON.stringify({
    op: "merge_entities", winner_id, loser_id, winner_name: winner.name, loser_name: loser.name,
    ...report, ts: new Date().toISOString(),
  }));
  return json({ ok: true, winner_id, loser_id, report });
}

// Contador de falhas consecutivas do cron de manutenção em KV (spec 40-ops/43;
// chaves e shape idênticos aos da spec 10-backend/22, que refina a semântica
// depois sem mudar contrato). Sucesso zera; falha incrementa e grava maint:alert.
// O GET /health expõe os valores pro monitor externo. Falha do PRÓPRIO alerting
// nunca propaga — KV transiente não pode derrubar o scheduled.
export async function trackMaintOutcome(env: Env, ok: boolean, message?: string): Promise<void> {
  try {
    if (ok) {
      await env.CACHE.put("maint:consecutive_failures", "0");
      return;
    }
    const prev = parseInt((await env.CACHE.get("maint:consecutive_failures")) ?? "0", 10) || 0;
    const n = prev + 1;
    await env.CACHE.put("maint:consecutive_failures", String(n));
    await env.CACHE.put(
      "maint:alert",
      JSON.stringify({ kind: "maint_sync_failing", consecutive: n, message: message ?? "unknown", at: new Date().toISOString() })
    );
  } catch (e: any) {
    console.error("[maint] alerting falhou (ignorado, cron segue):", e?.message || e);
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Dispatch por expressão de cron (wrangler.toml [triggers]): o cron diário
    // original segue no sync de manutenção; o cron semanal novo roda o snapshot
    // de backup D1→R2 (spec 50-console-v2/67). Falha de snapshot LOGA e fica
    // registrada no CACHE (backup:last) — nunca derruba o handler nem afeta o
    // fluxo diário.
    if (event.cron === SNAPSHOT_CRON) {
      ctx.waitUntil(
        runSnapshotRecorded(env)
          .then((r) =>
            console.log(
              "[backup]",
              JSON.stringify(r.ok ? { ok: true, prefix: r.prefix, total_rows: r.total_rows, bytes: r.bytes } : r)
            )
          )
          .catch((e) => console.error("[backup] erro:", e?.message || e))
      );
      return;
    }
    // handleMaintenanceSync já contabiliza sucesso/falha (trackMaintOutcome) e
    // run partial não mexe no contador (houve progresso). O catch cobre só
    // exceção inesperada fora do fluxo tratado.
    ctx.waitUntil(
      handleMaintenanceSync(env)
        .then((r) => console.log("[maint]", JSON.stringify(r)))
        .catch(async (e) => {
          console.error("[maint] erro:", e?.message || e);
          await trackMaintOutcome(env, false, String(e?.message || e));
        })
    );
    // Google Contacts no MESMO cron diário (specs/google-contacts-sync.md).
    // SEQUENCIAL de propósito: o drain do write-back roda ANTES do pull — uma
    // edição pendente na fila suspende o "Google vence" dela (anti-clobber), então
    // drenar primeiro devolve o pull ao comportamento pleno na mesma rodada.
    // Independente do maint; falhas vão pros contadores gsync:*/gpush:* próprios.
    ctx.waitUntil(
      drainGooglePushQueue(env)
        .then((r) => console.log("[gpush]", JSON.stringify(r)))
        .catch((e) => console.error("[gpush] erro:", e?.message || e))
        .then(() => runGoogleSync(env))
        .then((r) => console.log("[gsync]", JSON.stringify(r)))
        .catch(async (e) => {
          console.error("[gsync] erro:", e?.message || e);
          await trackGsyncOutcome(env, false, String(e?.message || e));
        })
    );
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Expert Console (front multi-vault) — só intercepta /app*. Retorna null
    // pra qualquer outra rota, deixando a API de entidades seguir abaixo.
    const appRes = await handleApp(req, env, ctx);
    if (appRes) return appRes;

    if (path === "/health" && method === "GET") {
      try {
        const r = await handleHealth(env);
        // Marcador de build no header (diagnóstico 19/07: confirmar que o deploy
        // realmente chega na URL pública). Header, não body: não muda o contrato.
        const h = new Headers(r.headers);
        h.set("x-build-marker", "gsync-fix-2026-07-19T17-45");
        return new Response(r.body, { status: r.status, headers: h });
      }
      catch (e: any) { return err(500, "health check failed", String(e?.message || e)); }
    }

    // Callback do OAuth do Google — PÚBLICA de propósito: quem chega aqui é o
    // BROWSER do dono redirecionado pelo Google (sem bearer). A autenticidade é o
    // nonce `state` de uso único em KV (specs/google-contacts-sync.md).
    if (path === "/google/callback" && method === "GET") {
      try { return await handleGoogleCallback(req, env); }
      catch (e: any) { return err(500, "google callback failed", String(e?.message || e)); }
    }

    // Rotas do SCRIPT de push da integração WhatsApp Agent (specs/whatsapp-groups-
    // sync.md + specs/whatsapp-interactions.md) — bearer PRÓPRIO (WHATSAPP_SYNC_TOKEN),
    // roteadas ANTES do requireAuth geral. Sem o secret, 503 (OPCIONAL, desligada).
    if (path.startsWith("/whatsapp/groups/") || path.startsWith("/whatsapp/interactions/")) {
      const waAuthErr = requireWaSyncAuth(req, env);
      if (waAuthErr) return waAuthErr;
      try {
        if (method === "POST" && path === "/whatsapp/groups/catalog") return await handleWaCatalogPush(req, env);
        if (method === "GET" && path === "/whatsapp/groups/config") return await handleWaConfigGet(env);
        if (method === "POST" && path === "/whatsapp/groups/import") return await handleWaImport(req, env);
        if (method === "POST" && path === "/whatsapp/interactions/import") return await handleWaInteractionsImport(req, env);
      } catch (e: any) {
        return err(500, "whatsapp groups route failed", String(e?.message || e));
      }
      return err(404, "not found");
    }

    // Idem pro Instagram Agent (specs/instagram-contacts-sync.md): bearer próprio
    // INSTAGRAM_SYNC_TOKEN; sem o secret → 503 (integração OPCIONAL, desligada).
    if (path.startsWith("/instagram/contacts/")) {
      const igAuthErr = requireIgSyncAuth(req, env);
      if (igAuthErr) return igAuthErr;
      try {
        if (method === "POST" && path === "/instagram/contacts/catalog") return await handleIgCatalogPush(req, env);
        if (method === "GET" && path === "/instagram/contacts/config") return await handleIgConfigGet(env);
        if (method === "POST" && path === "/instagram/contacts/import") return await handleIgImport(req, env);
        // Conexão AO VIVO com o agente (specs/instagram-contacts-live.md):
        if (method === "GET" && path === "/instagram/contacts/dossier") return await handleIgDossier(req, env);
        if (method === "POST" && path === "/instagram/contacts/push") return await handleIgPush(req, env, ctx);
      } catch (e: any) {
        return err(500, "instagram contacts route failed", String(e?.message || e));
      }
      return err(404, "not found");
    }

    const authErr = requireAuth(req, env);
    if (authErr) return authErr;

    try {
      // saves
      if (method === "POST" && path === "/save_person") return await handleSaveEntity(req, env, "person");
      if (method === "POST" && path === "/save_company") return await handleSaveEntity(req, env, "company");
      if (method === "POST" && path === "/save_entity") return await handleSaveEntity(req, env);
      // recall
      if (method === "GET" && (path === "/recall_entity" || path === "/recall_person")) return await handleRecall(url, env, req);
      // canon: fonte única dos enums (consumida pelo MCP standalone via GET /canon).
      // CONTACTS_PROXY_TOKEN (read-only) já cobre GET.
      if (method === "GET" && path === "/canon") {
        return json({
          ok: true,
          conn_types: [...CONN_TYPES],
          symmetric_conn_types: [...SYMMETRIC_CONN_TYPES],
          entity_kinds: [...ENTITY_KINDS],
          contact_categories: [...CONTACT_CATEGORIES],
          event_kinds: [...EVENT_KINDS],
          event_sources: [...EVENT_SOURCES],
        });
      }
      // list
      if (method === "GET" && path === "/list_entities") return await handleListEntities(url, env, req);
      if (method === "GET" && path === "/list_people") return await handleListEntities(url, env, req, "person");
      if (method === "GET" && path === "/list_companies") return await handleListEntities(url, env, req, "company");
      // lookup determinístico por telefone (match exato, não semântico)
      if (method === "GET" && path === "/get_contact_by_phone") return await handleContactByPhone(url, env, req);
      // graph
      if (method === "GET" && path === "/graph/data") return await handleGraphData(url, env);
      // edges / events / media
      if (method === "POST" && path === "/connect") return await handleConnect(req, env);
      // cron de manutenção — dispara manual (mesma lógica do scheduled diário)
      if (method === "POST" && path === "/maintenance/run") return json(await handleMaintenanceSync(env));
      // Pipedrive como integração OPCIONAL explícita (painel do Brain): status GET
      // liberado pro CONTACTS_PROXY_TOKEN, sync POST pro CONTACTS_WRITE_TOKEN
      // (allowlists em src/auth/tokens.ts). Sem PIPEDRIVE_API_KEY = desligada:
      // o sync (manual ou cron) responde erro explicando, sem contar como falha.
      if (method === "GET" && path === "/pipedrive/status") return await handlePipedriveStatus(env);
      if (method === "POST" && path === "/pipedrive/sync") return json(await handleMaintenanceSync(env));
      // Google Contacts sync (specs/google-contacts-sync.md). GETs liberados pro
      // CONTACTS_PROXY_TOKEN; POSTs pro CONTACTS_WRITE_TOKEN (allowlists em
      // src/auth/tokens.ts). /google/callback é pública e roteada ANTES do auth.
      if (method === "GET" && path === "/google/status") return await handleGoogleStatus(req, env);
      if (method === "GET" && path === "/google/labels") return await handleGoogleLabels(env);
      if (method === "POST" && path === "/google/connect-start") return await handleGoogleConnectStart(req, env);
      if (method === "POST" && path === "/google/config") return await handleGoogleConfig(req, env);
      if (method === "POST" && path === "/google/client") return await handleGoogleClientPost(req, env);
      if (method === "POST" && path === "/google/write-back") return await handleGoogleWriteBackPost(req, env);
      if (method === "POST" && path === "/google/sync") return await handleGoogleSyncRun(env);
      if (method === "POST" && path === "/google/disconnect") return await handleGoogleDisconnect(env);
      // WhatsApp Agent grupos — rotas do PAINEL do Brain (specs/whatsapp-groups-sync.md).
      // GET liberado pro CONTACTS_PROXY_TOKEN; POST pro CONTACTS_WRITE_TOKEN (allowlists
      // em src/auth/tokens.ts). As rotas do SCRIPT (/whatsapp/groups/*) são roteadas
      // ANTES do auth geral, com bearer próprio.
      if (method === "GET" && path === "/whatsapp/status") return await handleWaStatus(env);
      if (method === "POST" && path === "/whatsapp/allowlist") return await handleWaAllowlistPost(req, env);
      if (method === "POST" && path === "/whatsapp/create-members") return await handleWaCreateMembersPost(req, env);
      // Instagram Agent contatos — rotas do PAINEL (specs/instagram-contacts-sync.md).
      if (method === "GET" && path === "/instagram/status") return await handleIgStatus(env);
      if (method === "POST" && path === "/instagram/allowlist") return await handleIgAllowlistPost(req, env);
      if (method === "POST" && path === "/event") return await handleEvent(req, env, ctx);
      if (method === "POST" && path === "/attach_media") return await handleAttachMedia(req, env);
      if (method === "POST" && path === "/setup/reembed") return await handleReembedAll(req, env);
      // backfill resumível das similar edges pré-computadas (spec 10-backend/21 §1d).
      if (method === "POST" && path === "/setup/backfill-similar") return await handleBackfillSimilar(req, env);
      // provision: roda runMigrations (idempotente) e devolve o estado da _migrations.
      // Exige OWNER_TOKEN (CONTACTS_PROXY_TOKEN é GET-only). Ver spec 40-ops/44.
      if (method === "POST" && path === "/setup/provision") {
        await runMigrations(env);
        const rows = await env.DB.prepare(`SELECT id, applied_at FROM _migrations ORDER BY id`).all();
        return json({ ok: true, migrations: rows.results });
      }

      // /entities/:id/media  ou  /people/:id/media
      const mediaListMatch = path.match(/^\/(?:entities|people)\/([0-9a-f-]+)\/media$/i);
      if (method === "GET" && mediaListMatch) return await handleListEntityMedia(mediaListMatch[1], env);

      // merge de duplicatas (spec 30-features/34) — POST exige OWNER_TOKEN.
      if (method === "POST" && path === "/entities/merge") return await handleMergeEntities(req, env);

      // /entities/:id  ou  /people/:id
      const entMatch = path.match(/^\/(?:entities|people)\/([0-9a-f-]+)$/i);
      if (method === "GET" && entMatch) return await handleGetEntity(entMatch[1], env, req);
      // DELETE (spec 30-features/34): hard delete com confirm obrigatório. O
      // CONTACTS_PROXY_TOKEN (read-only) nunca passa — requireAuth só libera GET pra ele.
      if (method === "DELETE" && entMatch) return await handleDeleteEntity(entMatch[1], url, env);

      // DELETE /connections/:id (spec 30-features/34)
      const connMatch = path.match(/^\/connections\/([0-9a-f-]+)$/i);
      if (method === "DELETE" && connMatch) return await handleDeleteConnection(connMatch[1], url, env);

      // /media/:hash
      const mediaMatch = path.match(/^\/media\/([0-9a-f]{64})$/i);
      if (method === "GET" && mediaMatch) return await handleGetMedia(mediaMatch[1], env);

      return err(404, "route not found", { method, path });
    } catch (e: any) {
      return err(500, "internal error", String(e?.message || e));
    }
  },
};
