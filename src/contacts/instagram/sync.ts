// Integração OPCIONAL com o Instagram Agent — conversas escolhidas → contatos no
// grafo (specs/instagram-contacts-sync.md). Mesmo desenho da integração WhatsApp
// (src/whatsapp/sync.ts): estado em KV (igcontacts:*), tabela de vínculo ADITIVA
// (instagram_links, migration 0010), token próprio, allowlist no painel do Brain.
//
// Diferença deliberada pro WhatsApp grupos: aqui MARCAR a conversa no painel É o
// pedido de criação — se a pessoa não existe no vault (sem match por telefone nem
// por canal instagram), o import CRIA a person com source='instagram'. No WhatsApp
// a allowlist marca o GRUPO (dezenas de membros não escolhidos um a um), então lá
// membro desconhecido NÃO cria entidade. Aqui cada conversa foi escolhida uma a uma.
//
// O telefone (quando existe) vem da tabela compartilhada `contacts` do Supabase do
// agente (handoff IG→WhatsApp) — o script de push faz esse join; o worker só recebe.

import type { Env } from "../env";
import { phoneVariants } from "../util/phone";
import { reembedEntity } from "../entity-write";
import { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor } from "../embedding";
import { refreshSimilarEdges, SIMILARITY_TOP_K, SIMILARITY_MIN_SCORE } from "../web/similarity";
import { recordEvent } from "../events";

// Chaves KV — mesmo idioma do wagroups:*.
export const IGCONTACTS_KV = {
  catalog: "igcontacts:catalog",     // [{ igsid, username, name, follower_count }] + pushed_at
  allowlist: "igcontacts:allowlist", // string[] de igsids escolhidos no painel
  lastRun: "igcontacts:last_run",    // resumo da última importação
} as const;

const CATALOG_MAX = 800;

export interface IgCatalogItem {
  igsid: string;
  username: string | null;
  name: string | null;
  follower_count: number | null;
}
export interface IgCatalog { contacts: IgCatalogItem[]; pushed_at: string }
export interface IgImportContact { igsid: string; username?: string | null; name?: string | null; phone?: string | null }

export interface IgImportResult {
  ok: boolean;
  error?: string;
  imported: number;
  created: number;
  linked_existing: number;
  skipped_not_allowlisted: number;
  skipped_no_identity: number;
}

export async function readJsonKV<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.CACHE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// @Fulano_X → fulano_x (mesmo alfabeto do INSTAGRAM_RE de src/channels.ts).
export function normalizeIgUsername(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const v = u.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(v) ? v : null;
}

export function sanitizeIgCatalog(body: unknown): IgCatalogItem[] | null {
  const contacts = (body as { contacts?: unknown })?.contacts;
  if (!Array.isArray(contacts)) return null;
  const out: IgCatalogItem[] = [];
  for (const c of contacts.slice(0, CATALOG_MAX)) {
    const igsid = typeof (c as any)?.igsid === "string" ? (c as any).igsid.trim() : "";
    if (!igsid) continue;
    const username = normalizeIgUsername((c as any)?.username);
    const name = typeof (c as any)?.name === "string" && (c as any).name.trim() ? (c as any).name.trim() : null;
    if (!username && !name) continue; // sem identidade nenhuma não tem o que mostrar
    const fc = (c as any)?.follower_count;
    out.push({ igsid, username, name, follower_count: typeof fc === "number" && fc >= 0 ? Math.floor(fc) : null });
  }
  return out;
}

const reembedDeps = { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor };

async function reindexEntity(env: Env, id: string): Promise<void> {
  try {
    const r = await reembedEntity(env, id, reembedDeps);
    if (r.vector) {
      await refreshSimilarEdges(env, id, r.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    }
  } catch (e: any) {
    console.error("[igcontacts] reindex failed", id, e?.message || e);
  }
}

// Canal instagram na cartela (entity_channels, migration 0006) — idempotente pelo
// UNIQUE(entity_id, kind, value). Nunca mexe em primário (espelho é só email/phone).
async function upsertIgChannel(env: Env, entityId: string, username: string | null): Promise<void> {
  if (!username) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary)
     VALUES (?, ?, 'instagram', ?, 0)`
  ).bind(crypto.randomUUID(), entityId, username).run();
}

interface EntityHit { id: string }

// Resolve a entidade local: vínculo salvo → telefone (variantes) → canal instagram.
async function matchIgEntity(env: Env, c: IgImportContact, username: string | null): Promise<EntityHit | null> {
  const linked = await env.DB.prepare(
    `SELECT id FROM entities WHERE id = (SELECT entity_id FROM instagram_links WHERE igsid = ?)`
  ).bind(c.igsid).first<EntityHit>();
  if (linked) return linked;

  if (c.phone) {
    const variants = phoneVariants(c.phone);
    if (variants.length) {
      const ph = variants.map(() => "?").join(",");
      const byPhone = await env.DB.prepare(
        `SELECT id FROM entities WHERE kind = 'person' AND phone IN (${ph}) LIMIT 1`
      ).bind(...variants).first<EntityHit>();
      if (byPhone) return byPhone;
    }
  }
  if (username) {
    const byChannel = await env.DB.prepare(
      `SELECT entity_id AS id FROM entity_channels WHERE kind = 'instagram' AND value = ? LIMIT 1`
    ).bind(username).first<EntityHit>();
    if (byChannel) return byChannel;
  }
  return null;
}

async function upsertIgLink(env: Env, igsid: string, entityId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO instagram_links (igsid, entity_id, synced_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(igsid) DO UPDATE SET entity_id = excluded.entity_id, synced_at = datetime('now')`
  ).bind(igsid, entityId).run();
}

// ---------------------------------------------------------------------------
// Conexão AO VIVO com o Instagram Agent (specs/instagram-contacts-live.md):
// dossiê sob demanda (GET) + escrita POR INTENÇÃO (POST push). Diferente do
// import batch: aqui NÃO há allowlist — o gate é a intenção deliberada do agente
// que conversa (a tool push_to_vault do mcp-api-ig), e a regra de curadoria é
// server-side: enriquecer NUNCA toca name/category; criar entra como 'mapeado'.

export interface IgResolveKeys {
  entity_id?: string | null;
  igsid?: string | null;
  username?: string | null; // já normalizado (normalizeIgUsername)
  phone?: string | null;
}

export interface IgResolvedEntity { id: string; matched_via: "entity_id" | "igsid" | "username" | "phone" }

// Ordem de precedência: entity_id (vínculo salvo no agente) → igsid (vínculo
// durável instagram_links) → canal @ (username pode ser reciclado) → telefone
// (variantes de 9º dígito, coluna + cartela de canais).
// `personsOnly` (usado pelo push): match por canal só resolve pra kind='person'
// — company com canal instagram não recebe enrich de pessoa. ORDER BY entity_id
// nos canais: escolha determinística quando duas entidades têm o mesmo valor.
export async function resolveIgEntity(env: Env, k: IgResolveKeys, opts: { personsOnly?: boolean } = {}): Promise<IgResolvedEntity | null> {
  const kindJoin = opts.personsOnly ? " AND e.kind = 'person'" : "";
  if (k.entity_id) {
    const hit = await env.DB.prepare(`SELECT id FROM entities WHERE id = ?`)
      .bind(k.entity_id).first<EntityHit>();
    if (hit) return { id: hit.id, matched_via: "entity_id" };
    // entity apagada/mergeada: cai pros fallbacks (o agente corrige o vínculo depois)
  }
  if (k.igsid) {
    const linked = await env.DB.prepare(
      `SELECT id FROM entities WHERE id = (SELECT entity_id FROM instagram_links WHERE igsid = ?)`
    ).bind(k.igsid).first<EntityHit>();
    if (linked) return { id: linked.id, matched_via: "igsid" };
  }
  if (k.username) {
    const byChannel = await env.DB.prepare(
      `SELECT c.entity_id AS id FROM entity_channels c JOIN entities e ON e.id = c.entity_id${kindJoin}
        WHERE c.kind = 'instagram' AND c.value = ? ORDER BY c.entity_id LIMIT 1`
    ).bind(k.username).first<EntityHit>();
    if (byChannel) return { id: byChannel.id, matched_via: "username" };
  }
  if (k.phone) {
    const variants = phoneVariants(k.phone);
    if (variants.length) {
      const ph = variants.map(() => "?").join(",");
      const byPhone = await env.DB.prepare(
        `SELECT id FROM entities WHERE kind = 'person' AND phone IN (${ph}) LIMIT 1`
      ).bind(...variants).first<EntityHit>();
      if (byPhone) return { id: byPhone.id, matched_via: "phone" };
      const byPhoneChannel = await env.DB.prepare(
        `SELECT c.entity_id AS id FROM entity_channels c JOIN entities e ON e.id = c.entity_id${kindJoin}
          WHERE c.kind = 'phone' AND c.value IN (${ph}) ORDER BY c.entity_id LIMIT 1`
      ).bind(...variants).first<EntityHit>();
      if (byPhoneChannel) return { id: byPhoneChannel.id, matched_via: "phone" };
    }
  }
  return null;
}

// Forma canônica pra GRAVAR telefone: sempre a variante com DDI 55 quando
// existir (gravar o input cru sem 55 deixaria a entidade invisível pra lookups
// futuros canônicos — dedupe quebraria e nasceria duplicata).
function canonicalPhone(raw: string): string | null {
  const v = phoneVariants(raw);
  if (!v.length) return null;
  return v.find((x) => x.startsWith("55") && (x.length === 12 || x.length === 13)) ?? v[0];
}

export interface IgPushProfile {
  biography?: string | null;
  followers_count?: number | null;
  is_verified?: boolean | null;
  is_business?: boolean | null;
  category_name?: string | null;
  external_url?: string | null;
}

export interface IgPushInput extends IgResolveKeys {
  name?: string | null;
  photo_url?: string | null;
  profile?: IgPushProfile | null;
  context?: string | null;
}

export interface IgPushResult {
  ok: boolean;
  error?: string;
  action?: "created" | "enriched";
  entity_id?: string;
  linked_entity_id?: string; // em igsid_link_conflict: pra quem o vínculo durável aponta
  name?: string;
  category?: string | null;
  matched_via?: string;
  phone_conflict?: boolean;
  private?: boolean;
}

// Resumo da pesquisa que vira o log_event kind='note' (timeline + embedding).
function igResearchNote(username: string | null, p: IgPushProfile | null | undefined, context: string | null | undefined): string {
  const parts: string[] = [`Pesquisa Instagram Agent${username ? ` (@${username})` : ""}`];
  if (p?.biography) parts.push(`bio: ${p.biography}`);
  if (p?.followers_count != null) parts.push(`${p.followers_count} seguidores`);
  if (p?.is_verified) parts.push("verificado");
  if (p?.is_business && p?.category_name) parts.push(`negócio: ${p.category_name}`);
  else if (p?.category_name) parts.push(`categoria: ${p.category_name}`);
  if (p?.external_url) parts.push(`link: ${p.external_url}`);
  if (context && context.trim()) parts.push(context.trim());
  return parts.join(" — ");
}

// A engine da escrita por intenção. Regras (decisão do dono, 13/07/2026):
// existente → enriquece ADITIVO (link igsid + canal @ + phone se vazio) + evento
// de timeline; NUNCA sobrescreve name/category/campos curados. Novo → person
// category='mapeado' (só nome/@/foto), curadoria de categoria é sempre manual.
export async function pushIgContact(env: Env, input: IgPushInput, ctx?: ExecutionContext): Promise<IgPushResult> {
  const username = normalizeIgUsername(input.username);
  const igsid = typeof input.igsid === "string" && input.igsid.trim() ? input.igsid.trim() : null;
  const phoneRaw = typeof input.phone === "string" && input.phone.trim() ? input.phone.trim() : null;
  const entityId = typeof input.entity_id === "string" && input.entity_id.trim() ? input.entity_id.trim() : null;
  if (!igsid && !username && !phoneRaw && !entityId) {
    return { ok: false, error: "need at least one of entity_id/igsid/username/phone" };
  }

  // personsOnly: match por canal nunca resolve pra company/group — enrich de
  // pessoa em cima de outra kind corromperia o dossiê.
  const hit = await resolveIgEntity(env, { entity_id: entityId, igsid, username, phone: phoneRaw }, { personsOnly: true });
  const note = igResearchNote(username, input.profile, input.context);

  if (hit) {
    const ent = await env.DB.prepare(
      `SELECT id, name, category, phone, private FROM entities WHERE id = ?`
    ).bind(hit.id).first<{ id: string; name: string; category: string | null; phone: string | null; private: number }>();
    if (!ent) return { ok: false, error: "entity vanished mid-push" };

    // GUARD do vínculo durável (revisão 13/07, achado 1): se instagram_links já
    // aponta este igsid pra OUTRA entidade, NUNCA reapontar por match mais fraco
    // (entity_id stale do agente / username reciclado). Divergência = conflito
    // explícito pra curadoria humana; nenhuma escrita acontece.
    if (igsid) {
      const linked = await env.DB.prepare(
        `SELECT entity_id FROM instagram_links WHERE igsid = ?`
      ).bind(igsid).first<{ entity_id: string }>();
      if (linked && linked.entity_id !== ent.id) {
        return {
          ok: false, error: "igsid_link_conflict",
          entity_id: ent.id, linked_entity_id: linked.entity_id, matched_via: hit.matched_via,
        };
      }
      await upsertIgLink(env, igsid, ent.id);
    }
    await upsertIgChannel(env, ent.id, username);

    // phone só preenche VAZIO, sempre na forma canônica (com DDI 55); se outra
    // entidade já tem o número (coluna OU cartela de canais), não mexe —
    // colisão sinaliza possível duplicata, decisão humana.
    let phoneConflict = false;
    const phone = phoneRaw ? canonicalPhone(phoneRaw) : null;
    if (phone && !ent.phone) {
      const variants = phoneVariants(phoneRaw!);
      const ph = variants.map(() => "?").join(",");
      const ownerCol = await env.DB.prepare(
        `SELECT id FROM entities WHERE phone IN (${ph}) AND id != ? LIMIT 1`
      ).bind(...variants, ent.id).first<EntityHit>();
      const ownerCh = ownerCol ? null : await env.DB.prepare(
        `SELECT entity_id AS id FROM entity_channels WHERE kind = 'phone' AND value IN (${ph}) AND entity_id != ? LIMIT 1`
      ).bind(...variants, ent.id).first<EntityHit>();
      if (ownerCol || ownerCh) phoneConflict = true;
      else {
        await env.DB.prepare(`UPDATE entities SET phone = ? WHERE id = ?`).bind(phone, ent.id).run();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary)
           VALUES (?, ?, 'phone', ?, 0)`
        ).bind(crypto.randomUUID(), ent.id, phone).run();
      }
    }

    // Entidade privada: a nota nasce private (não vaza nas superfícies públicas
    // do vault) e a response NÃO devolve category — mesma regra do dossiê.
    const isPrivate = ent.private === 1;
    await recordEvent(env, { entity_id: ent.id, kind: "note", context: note, source: "instagram", private: isPrivate }, ctx);
    return {
      ok: true, action: "enriched", entity_id: ent.id, name: ent.name,
      matched_via: hit.matched_via,
      ...(isPrivate ? { private: true } : { category: ent.category }),
      ...(phoneConflict && { phone_conflict: true }),
    };
  }

  // Novo: entra como 'mapeado' — só nome/@/foto. Bio/followers ficam na nota de
  // timeline, não nos campos (campo de perfil é curadoria, não scrape).
  const displayName = (input.name ?? "").trim() || (username ? `@${username}` : "");
  if (!displayName) return { ok: false, error: "new contact needs name or username" };
  const id = crypto.randomUUID();
  const phone = phoneRaw ? canonicalPhone(phoneRaw) : null;
  const photoUrl = typeof input.photo_url === "string" && input.photo_url.trim() ? input.photo_url.trim() : null;
  const attributes = photoUrl ? JSON.stringify({ ig_photo_url: photoUrl }) : null;
  // batch(): entity + vínculos numa transação — crash no meio não deixa entidade
  // órfã sem canal (retry por username acharia nada e criaria DUPLICATA).
  const stmts = [
    env.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, source, private, category, attributes)
       VALUES (?, 'person', ?, ?, 'instagram', 0, 'mapeado', ?)`
    ).bind(id, displayName, phone, attributes),
  ];
  if (igsid) {
    stmts.push(env.DB.prepare(
      `INSERT INTO instagram_links (igsid, entity_id, synced_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(igsid) DO UPDATE SET entity_id = excluded.entity_id, synced_at = datetime('now')`
    ).bind(igsid, id));
  }
  if (username) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary)
       VALUES (?, ?, 'instagram', ?, 0)`
    ).bind(crypto.randomUUID(), id, username));
  }
  if (phone) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary)
       VALUES (?, ?, 'phone', ?, 1)`
    ).bind(crypto.randomUUID(), id, phone));
  }
  await env.DB.batch(stmts);
  // recordEvent(kind='note') já reembeda a entidade — sem reindex duplicado.
  await recordEvent(env, { entity_id: id, kind: "note", context: note, source: "instagram" }, ctx);
  return { ok: true, action: "created", entity_id: id, name: displayName, category: "mapeado" };
}

// A engine: importa as conversas marcadas (allowlist re-checada server-side).
export async function importIgContacts(env: Env, contacts: IgImportContact[]): Promise<IgImportResult> {
  const allowRaw = await readJsonKV<string[]>(env, IGCONTACTS_KV.allowlist);
  const allowlist = new Set(Array.isArray(allowRaw) ? allowRaw : []);

  const r: IgImportResult = {
    ok: true, imported: 0, created: 0, linked_existing: 0,
    skipped_not_allowlisted: 0, skipped_no_identity: 0,
  };

  for (const c of contacts) {
    if (!allowlist.has(c.igsid)) { r.skipped_not_allowlisted++; continue; }
    const username = normalizeIgUsername(c.username);
    const displayName = (c.name ?? "").trim() || (username ? `@${username}` : "");
    if (!displayName) { r.skipped_no_identity++; continue; }

    const hit = await matchIgEntity(env, c, username);
    if (hit) {
      // Existente: só vincula e adiciona o canal — nome/campos enriquecidos
      // localmente NUNCA são sobrescritos pelo Instagram.
      await upsertIgLink(env, c.igsid, hit.id);
      await upsertIgChannel(env, hit.id, username);
      r.linked_existing++;
    } else {
      const id = crypto.randomUUID();
      const phone = c.phone && phoneVariants(c.phone).length ? phoneVariants(c.phone)[0] : null;
      // batch(): entity + vínculos atômicos (mesmo motivo do pushIgContact — crash
      // parcial entre o INSERT da entity e o link/canal deixava entidade órfã sem
      // vínculo, e o re-run do import não a achava e criava DUPLICATA).
      const stmts = [
        env.DB.prepare(
          `INSERT INTO entities (id, kind, name, phone, source, private) VALUES (?, 'person', ?, ?, 'instagram', 0)`
        ).bind(id, displayName, phone),
        env.DB.prepare(
          `INSERT INTO instagram_links (igsid, entity_id, synced_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(igsid) DO UPDATE SET entity_id = excluded.entity_id, synced_at = datetime('now')`
        ).bind(c.igsid, id),
      ];
      if (username) {
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary)
           VALUES (?, ?, 'instagram', ?, 0)`
        ).bind(crypto.randomUUID(), id, username));
      }
      if (phone) {
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary)
           VALUES (?, ?, 'phone', ?, 1)`
        ).bind(crypto.randomUUID(), id, phone));
      }
      await env.DB.batch(stmts);
      await reindexEntity(env, id);
      r.created++;
    }
    r.imported++;
  }

  await env.CACHE.put(IGCONTACTS_KV.lastRun, JSON.stringify({ ...r, at: new Date().toISOString() }));
  return r;
}
