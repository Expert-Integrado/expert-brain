// Engine do sync Google Contacts → Contacts, MÃO ÚNICA (specs/google-contacts-sync.md).
// Mesmo desenho do cron de manutenção do Pipedrive (spec 10-backend/22): estado em
// KV (gsync:*), teto de trabalho por invocação com checkpoint resumível, contador
// de falhas consecutivas pro /health, e enriquecimento que NUNCA destrói dado local.
//
// Regras de campo (decisão registrada no Brain, task igwjy0qz2w0e):
//   - Google VENCE (quando não-vazio): name, phone, email, birthday — agenda é
//     fonte canônica de identidade/alcance.
//   - FILL-EMPTY-ONLY: company, role — enriquecimento local (Pipedrive/manual) não
//     é sobrescrito por organização desatualizada da agenda.
//   - NUNCA tocados: notes_text (dossiê), category, attributes, private, kind.
//   - Deleção no Google → só desfaz o VÍNCULO (linha de google_links); a entidade
//     e todo o histórico local ficam.
//   - Sem eventos na timeline: sync de agenda não é "interação" — o dossiê não
//     pode virar spam de "sincronizado do Google".
// Só entra quem pertence a alguma etiqueta CONFIGURADA (gsync:config) — nunca é
// espelho total da agenda.

import type { Env } from "../env";
import { phoneVariants } from "../util/phone";
import { updateEntityFields, reembedEntity } from "../entity-write";
import { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor } from "../embedding";
import { refreshSimilarEdges, SIMILARITY_TOP_K, SIMILARITY_MIN_SCORE } from "../web/similarity";
import { refreshAccessToken, GSYNC_CLIENT_KV, GSYNC_OAUTH_KV, GSYNC_WRITEBACK_KV } from "./oauth";
import { listConnectionsPage, extractPerson, type GooglePerson, type ExtractedPerson } from "./people";
import { hasPendingPush } from "./push";

// A extração canônica mudou pra people.ts (compartilhada com o push do write-back);
// reexport preserva os imports existentes (testes, routes).
export { extractPerson, type ExtractedPerson };

// Chaves KV — espelham o namespace maint:* do cron do Pipedrive.
export const GSYNC_KV = {
  client: GSYNC_CLIENT_KV,                 // { client_id, client_secret } salvos pelo painel (POST /google/client); precedência sobre env
  oauth: GSYNC_OAUTH_KV,                   // { refresh_token, connected_at, scope }
  writeBack: GSYNC_WRITEBACK_KV,           // { enabled } — toggle do write-back vault→Google (POST /google/write-back)
  config: "gsync:config",                  // { groups: string[] }  (resourceNames de contactGroups)
  syncToken: "gsync:sync_token",           // nextSyncToken da última varredura completa
  cursor: "gsync:cursor",                  // { pageToken, mode } de run parcial (teto atingido)
  lastRun: "gsync:last_run",               // resultado resumido da última invocação
  failures: "gsync:consecutive_failures",
  alert: "gsync:alert",
  statePrefix: "gsync:state:",             // nonce anti-CSRF do OAuth (TTL 600s)
} as const;

const GSYNC_MAX_DEFAULT = 300;

// `scope` gravado a partir do token response (fonte autoritativa). Ausente em
// grants antigos = readonly (scopeCanWrite trata undefined como false).
export interface GsyncOauth { refresh_token: string; connected_at: string; scope?: string }
export interface GsyncConfig { groups: string[] }
interface GsyncCursor { pageToken: string; mode: "full" | "incremental" }

export interface GsyncResult {
  ok: boolean;
  skipped?: string;
  error?: string;
  partial?: boolean;
  mode?: "full" | "incremental";
  scanned?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  unlinked?: number;
  ignored_out_of_groups?: number;
}

// Contador de falhas consecutivas (mesma semântica de trackMaintOutcome): sucesso
// zera; falha incrementa e grava gsync:alert. Falha do alerting nunca propaga.
export async function trackGsyncOutcome(env: Env, ok: boolean, message?: string): Promise<void> {
  try {
    if (ok) {
      await env.CACHE.put(GSYNC_KV.failures, "0");
      return;
    }
    const prev = parseInt((await env.CACHE.get(GSYNC_KV.failures)) ?? "0", 10) || 0;
    const n = prev + 1;
    await env.CACHE.put(GSYNC_KV.failures, String(n));
    await env.CACHE.put(
      GSYNC_KV.alert,
      JSON.stringify({ kind: "gsync_failing", consecutive: n, message: message ?? "unknown", at: new Date().toISOString() })
    );
  } catch (e: any) {
    console.error("[gsync] alerting falhou (ignorado):", e?.message || e);
  }
}

async function readJsonKV<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.CACHE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ---------- matching e upsert ----------

interface EntityRow {
  id: string; name: string; phone: string | null; email: string | null;
  company: string | null; role: string | null; birthday: string | null;
}

const reembedDeps = { embeddingTextFor, computeEmbedding, upsertVectorize, vectorMetadataFor };

// Reindexa embedding + similar edges — não-fatal, mesmo idioma do handleSaveEntity.
async function reindexEntity(env: Env, id: string): Promise<void> {
  try {
    const r = await reembedEntity(env, id, reembedDeps);
    if (r.vector) {
      await refreshSimilarEdges(env, id, r.vector, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
    }
  } catch (e: any) {
    console.error("[gsync] reindex failed", id, e?.message || e);
  }
}

// Resolve a entidade local: vínculo salvo → variantes de telefone → email exato.
async function matchEntity(env: Env, resourceName: string, x: ExtractedPerson): Promise<EntityRow | null> {
  const SELECT = "SELECT id, name, phone, email, company, role, birthday FROM entities";
  const linked = await env.DB.prepare(
    `${SELECT} WHERE id = (SELECT entity_id FROM google_links WHERE resource_name = ?)`
  ).bind(resourceName).first<EntityRow>();
  if (linked) return linked;

  if (x.phone) {
    const variants = phoneVariants(x.phone);
    const list = variants.length ? variants : [x.phone];
    const ph = list.map(() => "?").join(",");
    const byPhone = await env.DB.prepare(
      `${SELECT} WHERE kind = 'person' AND phone IN (${ph}) ORDER BY (phone = ?) DESC LIMIT 1`
    ).bind(...list, x.phone).first<EntityRow>();
    if (byPhone) return byPhone;
  }
  if (x.email) {
    const byEmail = await env.DB.prepare(
      `${SELECT} WHERE kind = 'person' AND LOWER(email) = ? LIMIT 1`
    ).bind(x.email).first<EntityRow>();
    if (byEmail) return byEmail;
  }
  return null;
}

// Dono ATUAL de um telefone no vault, QUALQUER kind. O índice UNIQUE de
// entities.phone é global, mas o dedupe do matchEntity só olha kind='person' —
// empresa/import com o mesmo número escapava do match e o INSERT explodia com
// UNIQUE constraint, matando a invocação INTEIRA do sync (visto 19/07 na
// varredura completa; o cursor travava no lote). Checar o dono antes de
// escrever telefone resolve sem afrouxar o dedupe.
interface PhoneOwnerRow extends EntityRow { kind: string }
async function phoneOwner(env: Env, phone: string): Promise<PhoneOwnerRow | null> {
  return await env.DB.prepare(
    "SELECT id, kind, name, phone, email, company, role, birthday FROM entities WHERE phone = ? LIMIT 1"
  ).bind(phone).first<PhoneOwnerRow>();
}

async function upsertLink(env: Env, resourceName: string, entityId: string, etag: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO google_links (resource_name, entity_id, etag, synced_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(resource_name) DO UPDATE SET entity_id = excluded.entity_id, etag = excluded.etag, synced_at = datetime('now')`
  ).bind(resourceName, entityId, etag).run();
}

type UpsertOutcome = "created" | "updated" | "unchanged";

export async function upsertFromGoogle(env: Env, p: GooglePerson): Promise<UpsertOutcome | "skipped_no_name"> {
  const x = extractPerson(p);
  if (!x.name) return "skipped_no_name";

  let existing = await matchEntity(env, p.resourceName, x);
  let insertPhone = x.phone;
  if (!existing && x.phone) {
    const owner = await phoneOwner(env, x.phone);
    if (owner && owner.kind === "person") {
      // Pessoa dona do número que o matchEntity não alcançou (defesa extra):
      // é o mesmo humano — trata como match em vez de criar duplicata.
      existing = owner;
    } else if (owner) {
      // Empresa/import cru com o mesmo número: o telefone FICA com quem já tem;
      // o contato nasce sem telefone (email/nome seguem) e o conflito é logado.
      console.warn("[gsync] telefone já pertence a outra entidade (não-person) — criando sem telefone", p.resourceName, owner.id, owner.kind);
      insertPhone = null;
    }
  }
  if (!existing) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, email, role, company, birthday, source, private)
       VALUES (?, 'person', ?, ?, ?, ?, ?, ?, 'google', 0)`
    ).bind(id, x.name, insertPhone, x.email, x.role, x.company, x.birthday).run();
    await upsertLink(env, p.resourceName, id, p.etag ?? null);
    await reindexEntity(env, id);
    return "created";
  }

  // Anti-clobber do write-back: entidade com push PENDENTE na fila não recebe o
  // "Google vence" desta rodada — a edição do vault ainda não chegou ao Google e
  // seria revertida (perdida) aqui. O drain roda ANTES do pull no cron; na próxima
  // rodada, com a fila limpa, o pull volta a valer.
  if (await hasPendingPush(env, existing.id)) {
    await upsertLink(env, p.resourceName, existing.id, p.etag ?? null);
    return "unchanged";
  }

  // Google vence: name/phone/email/birthday. Fill-empty: company/role. Campo que
  // não muda vira null (COALESCE não mexe) — e patch 100% null nem vai pro banco.
  // Telefone novo que já pertence a OUTRA entidade não entra no patch (mesmo
  // racional do create: UNIQUE global explodiria o run inteiro; o conflito é
  // logado e o telefone atual da entidade permanece).
  let phonePatch = x.phone && x.phone !== existing.phone ? x.phone : null;
  if (phonePatch) {
    const owner = await phoneOwner(env, phonePatch);
    if (owner && owner.id !== existing.id) {
      console.warn("[gsync] telefone do Google já pertence a outra entidade — mantendo o atual", p.resourceName, existing.id, "dono:", owner.id, owner.kind);
      phonePatch = null;
    }
  }
  const patch: Record<string, string | null> = {
    name: x.name && x.name !== existing.name ? x.name : null,
    phone: phonePatch,
    email: x.email && x.email !== (existing.email ?? "").toLowerCase() ? x.email : null,
    birthday: x.birthday && x.birthday !== existing.birthday ? x.birthday : null,
    company: x.company && !existing.company ? x.company : null,
    role: x.role && !existing.role ? x.role : null,
  };
  const changed = Object.values(patch).some((v) => v != null);
  if (changed) {
    // Anti-loop: escrita vinda do PULL nunca enfileira push de volta pro Google.
    await updateEntityFields(env, existing.id, patch, undefined, { enqueueGooglePush: false });
    if (patch.name || patch.company || patch.role) await reindexEntity(env, existing.id);
  }
  await upsertLink(env, p.resourceName, existing.id, p.etag ?? null);
  return changed ? "updated" : "unchanged";
}

// ---------- a engine ----------

export async function runGoogleSync(env: Env, opts: { max?: number } = {}): Promise<GsyncResult> {
  const oauth = await readJsonKV<GsyncOauth>(env, GSYNC_KV.oauth);
  if (!oauth?.refresh_token) return { ok: true, skipped: "not_connected" };
  const config = await readJsonKV<GsyncConfig>(env, GSYNC_KV.config);
  const groups = new Set(config?.groups ?? []);
  if (groups.size === 0) return { ok: true, skipped: "no_groups_configured" };

  const token = await refreshAccessToken(env, oauth.refresh_token);
  if (!token.ok) {
    await trackGsyncOutcome(env, false, token.error);
    // Depois do track (que grava alert genérico) pro alerta ESPECÍFICO prevalecer:
    // reconnect_required é acionável pelo dono; gsync_failing é só contador.
    if (token.reconnect) {
      await env.CACHE.put(GSYNC_KV.alert, JSON.stringify({ kind: "gsync_reconnect_required", at: new Date().toISOString() }));
    }
    return { ok: false, error: token.error };
  }

  const max = opts.max ?? (parseInt(env.GSYNC_MAX_PERSONS ?? "", 10) || GSYNC_MAX_DEFAULT);
  const cursor = await readJsonKV<GsyncCursor>(env, GSYNC_KV.cursor);
  let syncToken = cursor?.mode === "incremental" || !cursor ? await env.CACHE.get(GSYNC_KV.syncToken) : null;
  let mode: "full" | "incremental" = cursor?.mode ?? (syncToken ? "incremental" : "full");
  if (mode === "full") syncToken = null;
  let pageToken: string | null = cursor?.pageToken ?? null;

  const r: GsyncResult = { ok: true, mode, scanned: 0, created: 0, updated: 0, unchanged: 0, unlinked: 0, ignored_out_of_groups: 0 };
  let retriedExpired = false;

  while (true) {
    const page = await listConnectionsPage(token.access_token, {
      pageToken, syncToken: mode === "incremental" ? syncToken : null, requestSync: true,
      // Página do tamanho do teto: garante checkpoint (cursor) a cada `max`
      // contatos e mantém o run inteiro dentro do cap de subrequests do runtime.
      pageSize: max,
    });
    if (!page.ok) {
      // 410 EXPIRED: syncToken velho demais — descarta e recomeça FULL na mesma
      // invocação (uma vez só; se o full também der 410, algo maior está errado).
      if (page.status === 410 && mode === "incremental" && !retriedExpired) {
        retriedExpired = true;
        mode = "full";
        r.mode = "full";
        syncToken = null;
        pageToken = null;
        await env.CACHE.delete(GSYNC_KV.syncToken);
        await env.CACHE.delete(GSYNC_KV.cursor);
        continue;
      }
      await trackGsyncOutcome(env, false, page.error);
      return { ...r, ok: false, error: page.error };
    }

    console.log("[gsync] page ok conns:", page.connections.length, "scanned:", r.scanned, "mode:", mode);
    for (const person of page.connections) {
      r.scanned!++;
      const x = extractPerson(person);
      const inGroups = x.groups.some((g) => groups.has(g));
      if (x.deleted || !inGroups) {
        // Fora do escopo (deletado no Google ou sem etiqueta configurada): só
        // desfaz o vínculo se existir. Entidade local NUNCA é deletada.
        const del = await env.DB.prepare("DELETE FROM google_links WHERE resource_name = ?").bind(person.resourceName).run();
        if ((del.meta?.changes ?? 0) > 0) r.unlinked!++;
        else if (!x.deleted) r.ignored_out_of_groups!++;
        continue;
      }
      const outcome = await upsertFromGoogle(env, person);
      if (outcome === "created") r.created!++;
      else if (outcome === "updated") r.updated!++;
      else if (outcome === "unchanged") r.unchanged!++;
    }

    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      // Teto atingido no meio da varredura → checkpoint resumível; o próximo run
      // (cron ou manual) continua DESTA página. Progresso houve: não conta falha.
      if (r.scanned! >= max) {
        await env.CACHE.put(GSYNC_KV.cursor, JSON.stringify({ pageToken, mode } satisfies GsyncCursor));
        await env.CACHE.put(GSYNC_KV.lastRun, JSON.stringify({ ...r, partial: true, at: new Date().toISOString() }));
        await trackGsyncOutcome(env, true);
        return { ...r, partial: true };
      }
      continue;
    }

    // Última página: guarda o syncToken novo pro próximo run ser incremental.
    if (page.nextSyncToken) await env.CACHE.put(GSYNC_KV.syncToken, page.nextSyncToken);
    await env.CACHE.delete(GSYNC_KV.cursor);
    await env.CACHE.put(GSYNC_KV.lastRun, JSON.stringify({ ...r, at: new Date().toISOString() }));
    // Run que completou limpa alerta de reconexão antigo.
    await env.CACHE.delete(GSYNC_KV.alert);
    await trackGsyncOutcome(env, true);
    return r;
  }
}
