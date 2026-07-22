// Write-back vault→Google (specs/google-contacts-sync.md, seção write-back).
//
// Edição de identidade no vault enfileira a entidade em google_push_queue (D1) e
// tenta o push na hora (não-fatal); o cron diário drena o que sobrou ANTES do pull.
// O push é cirúrgico: getContact fresco → diff vault×Google com a MESMA extração
// do pull (extractPerson) → PATCH :updateContact SÓ dos campos divergentes, mutando
// só o item primário de cada lista (contato com 3 telefones mantém os 3) → regrava
// google_links.etag com o etag da RESPOSTA.
//
// Regras de segurança (escrita no Google não tem lixeira pra edição):
// - Whitelist FECHADA de campos: name/phone/email/birthday/company/role. Dossiê,
//   observações, categoria e privacidade NUNCA saem do vault.
// - Vault null NUNCA limpa campo no Google (assimetria deliberada).
// - Aniversário do vault com ano 0000 preserva o ano que o Google já tem.
// - Nunca cria nem deleta contato — só UPDATE de entidade já vinculada.
//
// Sem ciclo de import: este módulo consome oauth.ts + people.ts + env. sync.ts e
// entity-write.ts importam DAQUI, nunca o contrário.

import type { Env } from "../env";
import { refreshAccessToken, scopeCanWrite, GSYNC_OAUTH_KV, GSYNC_WRITEBACK_KV } from "./oauth";
import { getContact, updateContact, extractPerson, type RawPerson } from "./people";

export const GPUSH_KV = {
  lastPush: "gsync:last_push",   // { entity_id, resource_name, fields, at } do último envio ok
  failures: "gsync:push_failures", // falhas consecutivas de drain (alarme separado do pull)
} as const;

const IDENTITY_FIELDS = ["name", "phone", "email", "birthday", "company", "role"] as const;

const PUSH_MAX_DEFAULT = 25;

interface WriteBackFlag { enabled?: boolean }
interface OauthState { refresh_token?: string; scope?: string }

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.CACHE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function writeBackEnabled(env: Env): Promise<boolean> {
  const flag = await readJson<WriteBackFlag>(env, GSYNC_WRITEBACK_KV);
  return !!flag?.enabled;
}

// Entidade com push pendente? Usado pelo pull como anti-clobber: enquanto a edição
// do vault não chegou ao Google, o "Google vence" fica suspenso pra ela — senão o
// ciclo diário reverteria a edição antes do envio e ela se perderia sem rastro.
export async function hasPendingPush(env: Env, entityId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM google_push_queue WHERE entity_id = ?`).bind(entityId).first();
  return !!row;
}

// Gate barato→caro: campos do patch (zero IO) → toggle KV → grant com escopo de
// escrita → vínculo no D1. NUNCA lança — o save da entidade não pode falhar por
// causa do write-back. Retorna true se enfileirou.
export async function maybeEnqueueGooglePush(env: Env, entityId: string, patch: Record<string, unknown>): Promise<boolean> {
  try {
    if (!IDENTITY_FIELDS.some((f) => patch[f] != null)) return false;
    if (!(await writeBackEnabled(env))) return false;
    const oauth = await readJson<OauthState>(env, GSYNC_OAUTH_KV);
    if (!oauth?.refresh_token || !scopeCanWrite(oauth.scope)) return false;
    const linked = await env.DB.prepare(`SELECT 1 AS x FROM google_links WHERE entity_id = ?`).bind(entityId).first();
    if (!linked) return false;
    await env.DB.prepare(
      `INSERT INTO google_push_queue (entity_id) VALUES (?)
       ON CONFLICT(entity_id) DO UPDATE SET queued_at = datetime('now'), attempts = 0, last_error = NULL`
    ).bind(entityId).run();
    return true;
  } catch (e: any) {
    console.error("[gpush] enqueue failed", entityId, e?.message || e);
    return false;
  }
}

// Melhor esforço síncrono nos call sites de usuário (save/console/merge): se a
// entidade está na fila, tenta o push agora. Falha só fica registrada na fila —
// o cron drena depois. NUNCA lança.
export async function tryGooglePushNow(env: Env, entityId: string): Promise<void> {
  try {
    if (!(await hasPendingPush(env, entityId))) return;
    await pushEntityToGoogle(env, entityId);
  } catch (e: any) {
    console.error("[gpush] immediate push failed", entityId, e?.message || e);
  }
}

// ---------- construção cirúrgica do PATCH ----------

interface VaultIdentity {
  name: string | null; phone: string | null; email: string | null;
  birthday: string | null; company: string | null; role: string | null;
}

// Item alvo de uma lista = o marcado metadata.primary; fallback índice 0 (mesma
// posição que o extractPerson do pull lê — simetria pull/push).
function primaryIndex(list: any[] | undefined): number {
  if (!Array.isArray(list) || list.length === 0) return -1;
  const i = list.findIndex((it) => it?.metadata?.primary === true);
  return i >= 0 ? i : 0;
}

// Clona a lista removendo campos output-only por item (metadata, formatted*,
// canonicalForm) — o PATCH substitui a lista inteira e o Google recalcula esses.
function cleanList(list: any[] | undefined, keep: string[]): any[] {
  return (list ?? []).map((it) => {
    const out: Record<string, any> = {};
    for (const k of keep) if (it?.[k] !== undefined) out[k] = it[k];
    return out;
  });
}

// Diff vault×Google + corpo do PATCH. Campo entra SÓ se o valor do vault é
// não-nulo e difere do extraído (mesma régua do pull). Retorna as listas prontas
// e o updatePersonFields exato.
export function buildContactUpdate(raw: RawPerson, vault: VaultIdentity): { person: Record<string, any>; fields: string[] } {
  const x = extractPerson(raw as any);
  const fields: string[] = [];
  const person: Record<string, any> = { resourceName: raw.resourceName, etag: raw.etag };

  // names: displayName é read-only na escrita — unstructuredName faz o Google
  // re-parsear given/family. Contato de usuário tem 1 name; substituir a lista
  // pelo item novo é o caminho sem resíduo de campos estruturados conflitantes.
  if (vault.name && vault.name !== x.name) {
    person.names = [{ unstructuredName: vault.name }];
    fields.push("names");
  }

  if (vault.phone && vault.phone !== x.phone) {
    const list = cleanList(raw.phoneNumbers, ["value", "type"]);
    const i = primaryIndex(raw.phoneNumbers);
    const item = { ...(i >= 0 ? list[i] : {}), value: `+${vault.phone}` };
    if (i >= 0) list[i] = item; else list.push(item);
    person.phoneNumbers = list;
    fields.push("phoneNumbers");
  }

  if (vault.email && vault.email !== x.email) {
    const list = cleanList(raw.emailAddresses, ["value", "type"]);
    const i = primaryIndex(raw.emailAddresses);
    const item = { ...(i >= 0 ? list[i] : {}), value: vault.email };
    if (i >= 0) list[i] = item; else list.push(item);
    person.emailAddresses = list;
    fields.push("emailAddresses");
  }

  // company/role dividem organizations — qualquer um divergindo inclui o campo,
  // com vault null preservando o valor que o Google já tem no item alvo.
  const companyDiff = !!vault.company && vault.company !== x.company;
  const roleDiff = !!vault.role && vault.role !== x.role;
  if (companyDiff || roleDiff) {
    const list = cleanList(raw.organizations, ["name", "title", "type", "department"]);
    const i = primaryIndex(raw.organizations);
    const base = i >= 0 ? list[i] : {};
    const item = { ...base, name: vault.company ?? base.name, title: vault.role ?? base.title };
    if (i >= 0) list[i] = item; else list.push(item);
    person.organizations = list;
    fields.push("organizations");
  }

  // birthday: compara mês-dia; ano do vault só vale quando conhecido (≠0000) —
  // vault 0000 preserva o ano que o Google tem (não apagar ano da agenda).
  if (vault.birthday) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(vault.birthday);
    if (m) {
      const vy = parseInt(m[1], 10), vm = parseInt(m[2], 10), vd = parseInt(m[3], 10);
      const rawList = (raw.birthdays ?? []) as any[];
      const gi = rawList.findIndex((b) => b?.date?.month && b?.date?.day);
      const gdate = gi >= 0 ? rawList[gi].date : null;
      const differs = !gdate
        || gdate.month !== vm || gdate.day !== vd
        || (vy !== 0 && gdate.year !== vy);
      if (differs) {
        const year = vy !== 0 ? vy : (gdate?.year ?? undefined);
        const item = { date: { ...(year ? { year } : {}), month: vm, day: vd } };
        const list = cleanList(raw.birthdays, ["date"]);
        if (gi >= 0) list[gi] = item; else list.push(item);
        person.birthdays = list;
        fields.push("birthdays");
      }
    }
  }

  return { person, fields };
}

// ---------- execução ----------

export type PushOutcome =
  | { ok: true; pushed: string[] }
  | { ok: true; noop: string }
  | { ok: false; error: string };

async function dequeue(env: Env, entityId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM google_push_queue WHERE entity_id = ?`).bind(entityId).run();
}

async function markFailure(env: Env, entityId: string, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE google_push_queue SET attempts = attempts + 1, last_error = ? WHERE entity_id = ?`
  ).bind(error, entityId).run();
}

async function saveLinkEtag(env: Env, resourceName: string, etag: string | null): Promise<void> {
  await env.DB.prepare(
    `UPDATE google_links SET etag = ?, synced_at = datetime('now') WHERE resource_name = ?`
  ).bind(etag, resourceName).run();
}

export async function pushEntityToGoogle(env: Env, entityId: string): Promise<PushOutcome> {
  // Estado pode ter mudado desde o enqueue (toggle/scope/link) — re-checa tudo;
  // condição que desativa o push remove da fila (noop) pra não virar fila zumbi.
  const link = await env.DB.prepare(
    `SELECT resource_name FROM google_links WHERE entity_id = ?`
  ).bind(entityId).first<{ resource_name: string }>();
  if (!link) { await dequeue(env, entityId); return { ok: true, noop: "no_link" }; }

  if (!(await writeBackEnabled(env))) { await dequeue(env, entityId); return { ok: true, noop: "write_back_off" }; }
  const oauth = await readJson<OauthState>(env, GSYNC_OAUTH_KV);
  if (!oauth?.refresh_token) { await dequeue(env, entityId); return { ok: true, noop: "not_connected" }; }
  if (!scopeCanWrite(oauth.scope)) { await dequeue(env, entityId); return { ok: true, noop: "no_write_scope" }; }

  const entity = await env.DB.prepare(
    `SELECT name, phone, email, birthday, company, role FROM entities WHERE id = ?`
  ).bind(entityId).first<VaultIdentity>();
  if (!entity) { await dequeue(env, entityId); return { ok: true, noop: "entity_gone" }; }

  const token = await refreshAccessToken(env, oauth.refresh_token);
  if (!token.ok) { await markFailure(env, entityId, token.error); return { ok: false, error: token.error }; }

  const attempt = async (): Promise<PushOutcome | "stale"> => {
    const got = await getContact(token.access_token, link.resource_name);
    if (!got.ok) { await markFailure(env, entityId, got.error); return { ok: false, error: got.error }; }

    const { person, fields } = buildContactUpdate(got.person, entity);
    if (fields.length === 0) {
      // Nada a enviar (caso comum: eco pós-pull). Aproveita o etag fresco.
      await saveLinkEtag(env, link.resource_name, got.person.etag ?? null);
      await dequeue(env, entityId);
      return { ok: true, noop: "no_diff" };
    }

    const updated = await updateContact(token.access_token, link.resource_name, person, fields);
    if (!updated.ok) {
      if (updated.error.includes("FAILED_PRECONDITION")) return "stale"; // etag velho → refetch+retry (1x)
      await markFailure(env, entityId, updated.error);
      return { ok: false, error: updated.error };
    }

    await saveLinkEtag(env, link.resource_name, updated.person.etag ?? null);
    await dequeue(env, entityId);
    // Auditoria: o que saiu do vault pro Google, e quando (mesmo idioma do [gsync]).
    console.log("[gpush] pushed", JSON.stringify({ entity_id: entityId, resource_name: link.resource_name, fields }));
    await env.CACHE.put(GPUSH_KV.lastPush, JSON.stringify({ entity_id: entityId, resource_name: link.resource_name, fields, at: new Date().toISOString() }));
    return { ok: true, pushed: fields };
  };

  const first = await attempt();
  if (first !== "stale") return first;
  const second = await attempt();
  if (second === "stale") {
    await markFailure(env, entityId, "etag_stale_twice");
    return { ok: false, error: "etag_stale_twice" };
  }
  return second;
}

// Drena a fila (cron diário, ANTES do pull — anti-clobber). Teto por invocação
// (GSYNC_PUSH_MAX, default 25) protege quota e tempo de execução; o resto fica
// pro próximo ciclo. Contador de falhas consecutivas separado do pull.
export async function drainGooglePushQueue(env: Env, opts: { max?: number } = {}): Promise<{ ok: boolean; pushed: number; failed: number; noop: number }> {
  const max = opts.max ?? (parseInt(env.GSYNC_PUSH_MAX ?? "", 10) || PUSH_MAX_DEFAULT);
  const rows = await env.DB.prepare(
    `SELECT entity_id FROM google_push_queue ORDER BY queued_at ASC LIMIT ?`
  ).bind(max).all<{ entity_id: string }>();
  let pushed = 0, failed = 0, noop = 0;
  for (const row of rows.results ?? []) {
    const r = await pushEntityToGoogle(env, row.entity_id);
    if (!r.ok) failed++;
    else if ("pushed" in r) pushed++;
    else noop++;
  }
  try {
    if (failed > 0) {
      const cur = parseInt((await env.CACHE.get(GPUSH_KV.failures)) ?? "0", 10) || 0;
      await env.CACHE.put(GPUSH_KV.failures, String(cur + 1));
    } else {
      await env.CACHE.put(GPUSH_KV.failures, "0");
    }
  } catch { /* contador é telemetria — nunca derruba o drain */ }
  return { ok: failed === 0, pushed, failed, noop };
}
