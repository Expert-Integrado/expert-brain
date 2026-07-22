// Integração OPCIONAL com o WhatsApp Agent — grupos → grafo de contatos
// (specs/whatsapp-groups-sync.md). Espelho do desenho do Google sync
// (src/google/sync.ts): estado em KV (wagroups:*), tabela de vínculo ADITIVA
// (whatsapp_links, migration 0009) e enriquecimento que NUNCA destrói dado local.
//
// Regras (decisão do dono, 08/07/2026):
//   - Integração OPCIONAL: sem o secret WHATSAPP_SYNC_TOKEN configurado, as rotas
//     do script respondem 503 e o painel mostra "não configurado".
//   - Só sincroniza grupos ALLOWLISTADOS (wagroups:allowlist, escolhidos no painel
//     do Brain) — nunca é espelho de todos os grupos do WhatsApp.
//   - Participante SÓ vira vínculo se JÁ existe como person no vault (match por
//     variantes de telefone). Número desconhecido NÃO cria entidade — grupo grande
//     viraria lixo no grafo. Não-mapeados voltam como contador + amostra.
//   - Grupo vira entidade kind='group' source='whatsapp'; deleção/saída só desfaz
//     vínculos criados POR ESTE sync (marcador no why) — edge manual fica.

import type { Env } from "../env";
import { normalizePhone, phoneVariants } from "../util/phone";
import { reembedEntity } from "../entity-write";
import { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor } from "../embedding";
import { refreshSimilarEdges, SIMILARITY_TOP_K, SIMILARITY_MIN_SCORE } from "../web/similarity";

// Chaves KV — mesmo idioma do gsync:*.
export const WAGROUPS_KV = {
  catalog: "wagroups:catalog",     // [{ chat_id, name, member_count }] + pushed_at
  allowlist: "wagroups:allowlist", // string[] de chat_ids escolhidos no painel
  lastRun: "wagroups:last_run",    // resumo da última importação
  createMembers: "wagroups:create_members", // "1" = membro desconhecido de grupo allowlistado VIRA person (default OFF)
} as const;

// Marcador do why: identifica vínculo criado por ESTE sync (replace-set só apaga
// o que ele mesmo criou; edge member_of manual nunca é tocado).
export const WAGROUPS_WHY_PREFIX = "Membro do grupo de WhatsApp";

const CATALOG_MAX_GROUPS = 500;
const UNMATCHED_SAMPLE_MAX = 10;
// Criações por REQUEST com o toggle ligado: cada criação custa reindex (AI +
// Vectorize + D1) — grupo grande estouraria o cap de subrequests do Worker.
// O excedente volta em creation_capped; o próximo run continua de onde parou.
export const MEMBERS_CREATE_CAP = 100;

export interface WaCatalogGroup { chat_id: string; name: string; member_count: number | null }
export interface WaCatalog { groups: WaCatalogGroup[]; pushed_at: string }
export interface WaParticipant { phone: string; name?: string | null }
export interface WaImportGroup { chat_id: string; name: string; participants: WaParticipant[] }

export interface WaImportResult {
  ok: boolean;
  error?: string;
  groups_imported: number;
  skipped_not_allowlisted: number;
  members_linked: number;
  members_unlinked: number;
  members_created: number;   // persons criadas pelo toggle create_members (0 com toggle OFF)
  creation_capped: number;   // desconhecidos que ficaram pro próximo run (MEMBERS_CREATE_CAP)
  unmatched: number;
  unmatched_sample: string[];
}

export async function readJsonKV<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.CACHE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// Sanitiza o catálogo empurrado pelo script (nome de grupo é dado pessoal do dono,
// mas o payload é validado mesmo assim — a rota é autenticada, não confiável cega).
export function sanitizeCatalog(body: unknown): WaCatalogGroup[] | null {
  const groups = (body as { groups?: unknown })?.groups;
  if (!Array.isArray(groups)) return null;
  const out: WaCatalogGroup[] = [];
  for (const g of groups.slice(0, CATALOG_MAX_GROUPS)) {
    const chatId = typeof (g as any)?.chat_id === "string" ? (g as any).chat_id.trim() : "";
    const name = typeof (g as any)?.name === "string" ? (g as any).name.trim() : "";
    if (!chatId || !name) continue;
    const mc = (g as any)?.member_count;
    out.push({ chat_id: chatId, name, member_count: typeof mc === "number" && mc >= 0 ? Math.floor(mc) : null });
  }
  return out;
}

const reembedDeps = { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor };

// Reindexa embedding + similar edges — não-fatal (mesmo idioma do gsync).
async function reindexEntity(env: Env, id: string): Promise<void> {
  try {
    const r = await reembedEntity(env, id, reembedDeps);
    if (r.vector) {
      await refreshSimilarEdges(env, id, r.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    }
  } catch (e: any) {
    console.error("[wagroups] reindex failed", id, e?.message || e);
  }
}

// Upsert da ENTIDADE do grupo: vínculo salvo (whatsapp_links) → cria se não existe.
// Rename no WhatsApp atualiza o name local (o grupo não tem enriquecimento manual
// de name que valha preservar — a fonte do nome É o WhatsApp).
async function upsertGroupEntity(env: Env, g: WaImportGroup): Promise<{ id: string; created: boolean }> {
  const linked = await env.DB.prepare(
    `SELECT e.id, e.name FROM entities e
      WHERE e.id = (SELECT entity_id FROM whatsapp_links WHERE chat_id = ?)`
  ).bind(g.chat_id).first<{ id: string; name: string }>();

  if (linked) {
    if (linked.name !== g.name) {
      await env.DB.prepare(`UPDATE entities SET name = ? WHERE id = ?`).bind(g.name, linked.id).run();
      await reindexEntity(env, linked.id);
    }
    await env.DB.prepare(
      `UPDATE whatsapp_links SET synced_at = datetime('now') WHERE chat_id = ?`
    ).bind(g.chat_id).run();
    return { id: linked.id, created: false };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, source, private) VALUES (?, 'group', ?, 'whatsapp', 0)`
  ).bind(id, g.name).run();
  await env.DB.prepare(
    `INSERT INTO whatsapp_links (chat_id, entity_id, synced_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET entity_id = excluded.entity_id, synced_at = datetime('now')`
  ).bind(g.chat_id, id).run();
  await reindexEntity(env, id);
  return { id, created: true };
}

// Resolve participantes → persons existentes num LOTE só: junta as variantes de
// telefone de todos e faz SELECT IN chunked (100) — grupos de 100+ membros não
// estouram o cap de subrequests do D1 com 1 query por pessoa.
async function matchParticipants(
  env: Env,
  participants: WaParticipant[],
): Promise<{ matched: Map<string, string>; unmatched: WaParticipant[] }> {
  const variantsOf = new Map<string, string[]>(); // phone cru → variantes
  const allVariants = new Set<string>();
  for (const p of participants) {
    const v = phoneVariants(p.phone ?? "");
    if (v.length === 0) continue;
    variantsOf.set(p.phone, v);
    for (const x of v) allVariants.add(x);
  }

  const byPhone = new Map<string, string>(); // phone salvo → entity_id
  const list = [...allVariants];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const ph = chunk.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id, phone FROM entities WHERE kind = 'person' AND phone IN (${ph})`
    ).bind(...chunk).all<{ id: string; phone: string }>();
    for (const row of r.results ?? []) byPhone.set(row.phone, row.id);
  }
  // fallback: número que só vive em entity_channels kind='phone' também casa —
  // espelho do lookup (handleContactByPhone). Match pela coluna tem precedência.
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const ph = chunk.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT e.id, ch.value FROM entity_channels ch JOIN entities e ON e.id = ch.entity_id
        WHERE e.kind = 'person' AND ch.kind = 'phone' AND ch.value IN (${ph})`
    ).bind(...chunk).all<{ id: string; value: string }>();
    for (const row of r.results ?? []) if (!byPhone.has(row.value)) byPhone.set(row.value, row.id);
  }

  const matched = new Map<string, string>(); // entity_id → nome/phone de exibição
  const unmatched: WaParticipant[] = [];
  for (const p of participants) {
    const v = variantsOf.get(p.phone);
    const hit = v?.map((x) => byPhone.get(x)).find((id): id is string => !!id);
    if (hit) matched.set(hit, p.name?.trim() || p.phone);
    else unmatched.push(p);
  }
  return { matched, unmatched };
}

// Replace-set dos vínculos member_of do grupo: insere os que faltam, remove os
// que ESTE sync criou (why com marcador) e cujo membro saiu. Edge manual fica.
async function syncMembers(
  env: Env,
  groupId: string,
  groupName: string,
  memberIds: Set<string>,
): Promise<{ linked: number; unlinked: number }> {
  const existing = (
    await env.DB.prepare(
      `SELECT id, a_id, b_id, why FROM connections WHERE type = 'member_of' AND (a_id = ? OR b_id = ?)`
    ).bind(groupId, groupId).all<{ id: string; a_id: string; b_id: string; why: string }>()
  ).results ?? [];

  const existingByMember = new Map<string, { id: string; why: string }>();
  for (const c of existing) {
    const other = c.a_id === groupId ? c.b_id : c.a_id;
    existingByMember.set(other, { id: c.id, why: c.why });
  }

  let linked = 0;
  const why = `${WAGROUPS_WHY_PREFIX} "${groupName}" (sync WhatsApp Agent)`;
  for (const memberId of memberIds) {
    if (existingByMember.has(memberId)) continue;
    await env.DB.prepare(
      `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, 'member_of', 0.5, ?)`
    ).bind(crypto.randomUUID(), memberId, groupId, why).run();
    linked++;
  }

  let unlinked = 0;
  for (const [memberId, c] of existingByMember) {
    if (memberIds.has(memberId)) continue;
    if (!c.why?.startsWith(WAGROUPS_WHY_PREFIX)) continue; // edge manual: intocado
    await env.DB.prepare(`DELETE FROM connections WHERE id = ?`).bind(c.id).run();
    unlinked++;
  }
  return { linked, unlinked };
}

// Membro desconhecido → person (SÓ com o toggle wagroups:create_members ligado).
// Espelho do idioma de criação do Instagram sync: entities + canal phone primário
// + reindex. Dedupe por variante de telefone dentro da mesma request (a mesma
// pessoa em 2 grupos cria UMA entidade).
async function createMember(
  env: Env,
  p: WaParticipant,
  createdByVariant: Map<string, string>,
): Promise<string> {
  const id = crypto.randomUUID();
  // telefone sempre na forma canônica (dígitos, variante [0] — espelho do
  // Instagram sync): gravar o valor cru quebra o casamento por variantes depois.
  const canonical = phoneVariants(p.phone)[0] ?? normalizePhone(p.phone) ?? p.phone;
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, phone, source, private) VALUES (?, 'person', ?, ?, 'whatsapp', 0)`
  ).bind(id, p.name?.trim() || canonical, canonical).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary)
     VALUES (?, ?, 'phone', ?, 1)`
  ).bind(crypto.randomUUID(), id, canonical).run();
  await reindexEntity(env, id);
  for (const v of phoneVariants(p.phone)) createdByVariant.set(v, id);
  return id;
}

// A engine: importa os grupos empurrados pelo script, respeitando a allowlist
// (dupla checagem — o script já filtra, mas o servidor não confia).
export async function importWaGroups(env: Env, groups: WaImportGroup[]): Promise<WaImportResult> {
  const allowRaw = await readJsonKV<string[]>(env, WAGROUPS_KV.allowlist);
  const allowlist = new Set(Array.isArray(allowRaw) ? allowRaw : []);
  const createMembers = (await env.CACHE.get(WAGROUPS_KV.createMembers)) === "1";

  const r: WaImportResult = {
    ok: true, groups_imported: 0, skipped_not_allowlisted: 0,
    members_linked: 0, members_unlinked: 0, members_created: 0, creation_capped: 0,
    unmatched: 0, unmatched_sample: [],
  };
  let createBudget = MEMBERS_CREATE_CAP;
  const createdByVariant = new Map<string, string>(); // variante de fone → entity criada nesta request

  for (const g of groups) {
    if (!allowlist.has(g.chat_id)) { r.skipped_not_allowlisted++; continue; }
    const { id: groupId } = await upsertGroupEntity(env, g);
    const { matched, unmatched } = await matchParticipants(env, g.participants ?? []);
    const memberIds = new Set(matched.keys());

    const stillUnmatched: WaParticipant[] = [];
    for (const p of unmatched) {
      if (!createMembers) { stillUnmatched.push(p); continue; }
      const variants = phoneVariants(p.phone);
      if (variants.length === 0) { stillUnmatched.push(p); continue; }
      const already = variants.map((v) => createdByVariant.get(v)).find((id): id is string => !!id);
      if (already) { memberIds.add(already); continue; }
      if (createBudget <= 0) { r.creation_capped++; continue; }
      memberIds.add(await createMember(env, p, createdByVariant));
      r.members_created++;
      createBudget--;
    }

    const { linked, unlinked } = await syncMembers(env, groupId, g.name, memberIds);
    r.groups_imported++;
    r.members_linked += linked;
    r.members_unlinked += unlinked;
    r.unmatched += stillUnmatched.length;
    for (const p of stillUnmatched) {
      if (r.unmatched_sample.length >= UNMATCHED_SAMPLE_MAX) break;
      r.unmatched_sample.push(p.name?.trim() || p.phone);
    }
  }

  await env.CACHE.put(WAGROUPS_KV.lastRun, JSON.stringify({ ...r, at: new Date().toISOString() }));
  return r;
}
