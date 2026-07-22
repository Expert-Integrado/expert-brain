// Rotas HTTP da integração WhatsApp Agent → grupos (specs/whatsapp-groups-sync.md).
//
// Auth em DUAS camadas (ver src/auth/tokens.ts e src/index.ts):
//   Rotas do SCRIPT de push (roteadas ANTES do requireAuth geral, com bearer próprio):
//     POST /whatsapp/groups/catalog  — script empurra o catálogo de grupos
//     GET  /whatsapp/groups/config   — script lê a allowlist antes de montar o payload
//     POST /whatsapp/groups/import   — script empurra membros dos grupos allowlistados
//     Bearer aceito: WHATSAPP_SYNC_TOKEN (dedicado) ou OWNER_TOKEN (debug manual).
//     Sem WHATSAPP_SYNC_TOKEN configurado → 503 (integração OPCIONAL: desligada).
//   Rotas do PAINEL do Brain (passam pelo requireAuth geral):
//     GET  /whatsapp/status     — OWNER_TOKEN ou CONTACTS_PROXY_TOKEN
//     POST /whatsapp/allowlist  — OWNER_TOKEN ou CONTACTS_WRITE_TOKEN

import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth/tokens";
import {
  WAGROUPS_KV, readJsonKV, sanitizeCatalog, importWaGroups,
  type WaCatalog, type WaImportGroup,
} from "./sync";
import { WAINTERACTIONS_KV, sanitizePairs, importWaInteractions } from "./interactions";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init?.headers },
  });
const err = (status: number, message: string) => json({ ok: false, error: message }, { status });

// Auth das rotas do script. Null = autorizado.
export function requireWaSyncAuth(req: Request, env: Env): Response | null {
  if (!env.WHATSAPP_SYNC_TOKEN) return err(503, "whatsapp_sync_not_configured");
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (timingSafeEqualStr(token, env.WHATSAPP_SYNC_TOKEN)) return null;
  if (env.OWNER_TOKEN && timingSafeEqualStr(token, env.OWNER_TOKEN)) return null;
  return err(401, "unauthorized");
}

// POST /whatsapp/groups/catalog — script empurra {groups: [{chat_id, name, member_count}]}.
// Substitui o catálogo inteiro (o script sempre manda a lista completa de grupos).
export async function handleWaCatalogPush(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  const groups = sanitizeCatalog(body);
  if (!groups) return err(400, "groups must be an array of {chat_id, name}");
  const catalog: WaCatalog = { groups, pushed_at: new Date().toISOString() };
  await env.CACHE.put(WAGROUPS_KV.catalog, JSON.stringify(catalog));
  return json({ ok: true, groups: groups.length });
}

// GET /whatsapp/groups/config — allowlist pro script saber o que empurrar no import.
export async function handleWaConfigGet(env: Env): Promise<Response> {
  const allowlist = (await readJsonKV<string[]>(env, WAGROUPS_KV.allowlist)) ?? [];
  return json({ ok: true, allowlist });
}

// POST /whatsapp/groups/import — script empurra os grupos allowlistados com membros.
export async function handleWaImport(req: Request, env: Env): Promise<Response> {
  let body: { groups?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (!Array.isArray(body.groups)) return err(400, "groups must be an array");
  const groups: WaImportGroup[] = [];
  for (const g of body.groups) {
    const chatId = typeof (g as any)?.chat_id === "string" ? (g as any).chat_id.trim() : "";
    const name = typeof (g as any)?.name === "string" ? (g as any).name.trim() : "";
    if (!chatId || !name) return err(400, "each group needs chat_id and name");
    const rawParts = Array.isArray((g as any)?.participants) ? (g as any).participants : [];
    const participants = rawParts
      .map((p: any) => ({
        phone: typeof p?.phone === "string" ? p.phone.trim() : "",
        name: typeof p?.name === "string" ? p.name : null,
      }))
      .filter((p: { phone: string }) => p.phone.length > 0);
    groups.push({ chat_id: chatId, name, participants });
  }
  return json(await importWaGroups(env, groups));
}

// POST /whatsapp/interactions/import — script empurra pares "quem conversa com
// quem" agregados das mensagens de grupo (specs/whatsapp-interactions.md).
// Mesmo bearer do sync de grupos (integração OPCIONAL: sem token → 503).
export async function handleWaInteractionsImport(req: Request, env: Env): Promise<Response> {
  let body: { pairs?: unknown; window_days?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  const pairs = sanitizePairs(body);
  if (!pairs) return err(400, "pairs must be an array of {a_phone, b_phone, replies}");
  const wd = Number(body.window_days);
  const windowDays = Number.isFinite(wd) && wd > 0 ? Math.floor(wd) : null;
  return json(await importWaInteractions(env, pairs, windowDays));
}

// GET /whatsapp/status — visão pro painel do Brain: integração configurada?,
// catálogo disponível, allowlist atual, último run e nº de grupos vinculados.
export async function handleWaStatus(env: Env): Promise<Response> {
  const [catalog, allowlist, lastRun, interactionsLastRun, createMembers] = await Promise.all([
    readJsonKV<WaCatalog>(env, WAGROUPS_KV.catalog),
    readJsonKV<string[]>(env, WAGROUPS_KV.allowlist),
    readJsonKV<Record<string, unknown>>(env, WAGROUPS_KV.lastRun),
    readJsonKV<Record<string, unknown>>(env, WAINTERACTIONS_KV.lastRun),
    env.CACHE.get(WAGROUPS_KV.createMembers),
  ]);
  let linked = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM whatsapp_links").first<{ n: number }>();
    linked = row?.n ?? 0;
  } catch { /* tabela ainda não provisionada — status degrada pra 0 */ }
  return json({
    ok: true,
    configured: !!env.WHATSAPP_SYNC_TOKEN,
    catalog: catalog?.groups ?? [],
    catalog_pushed_at: catalog?.pushed_at ?? null,
    allowlist: Array.isArray(allowlist) ? allowlist : [],
    // Distingue "dono nunca salvou" (painel pré-marca tudo) de "salvou vazio de
    // propósito" (pausa). O import continua exigindo allowlist salva.
    allowlist_set: allowlist !== null,
    last_run: lastRun,
    interactions_last_run: interactionsLastRun,
    groups_linked: linked,
    create_members: createMembers === "1",
  });
}

// POST /whatsapp/create-members {enabled: boolean} — toggle "membro desconhecido
// de grupo allowlistado VIRA contato" (default OFF). Grava só o flag em KV; a
// criação acontece no próximo import do script (source='whatsapp', cap por request).
export async function handleWaCreateMembersPost(req: Request, env: Env): Promise<Response> {
  let body: { enabled?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (typeof body.enabled !== "boolean") return err(400, "enabled must be a boolean");
  await env.CACHE.put(WAGROUPS_KV.createMembers, body.enabled ? "1" : "0");
  return json({ ok: true, create_members: body.enabled });
}

// POST /whatsapp/allowlist {chat_ids: string[]} — painel escolhe QUAIS grupos
// sincronizar. Vazio é válido (pausa o import sem apagar nada já importado).
export async function handleWaAllowlistPost(req: Request, env: Env): Promise<Response> {
  let body: { chat_ids?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (!Array.isArray(body.chat_ids)) return err(400, "chat_ids must be an array");
  const chatIds = body.chat_ids.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  if (chatIds.length !== body.chat_ids.length) return err(400, "chat_ids must be non-empty strings");
  await env.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify(chatIds));
  return json({ ok: true, allowlist: chatIds });
}
