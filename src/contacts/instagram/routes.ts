// Rotas HTTP da integração Instagram Agent → contatos (specs/instagram-contacts-sync.md).
// Mesmo desenho das rotas do WhatsApp (src/whatsapp/routes.ts):
//   Rotas do SCRIPT (bearer INSTAGRAM_SYNC_TOKEN próprio, roteadas ANTES do requireAuth):
//     POST /instagram/contacts/catalog  — script empurra o catálogo de conversas
//     GET  /instagram/contacts/config   — script lê a allowlist
//     POST /instagram/contacts/import   — script empurra as conversas marcadas
//     Sem INSTAGRAM_SYNC_TOKEN configurado → 503 (integração OPCIONAL: desligada).
//   Rotas do PAINEL do Brain (requireAuth geral):
//     GET  /instagram/status     — OWNER_TOKEN ou CONTACTS_PROXY_TOKEN
//     POST /instagram/allowlist  — OWNER_TOKEN ou CONTACTS_WRITE_TOKEN

import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth/tokens";
import { getChannels, channelHref } from "../channels";
import {
  IGCONTACTS_KV, readJsonKV, sanitizeIgCatalog, importIgContacts, normalizeIgUsername,
  resolveIgEntity, pushIgContact,
  type IgCatalog, type IgImportContact, type IgPushInput,
} from "./sync";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init?.headers },
  });
const err = (status: number, message: string) => json({ ok: false, error: message }, { status });

export function requireIgSyncAuth(req: Request, env: Env): Response | null {
  if (!env.INSTAGRAM_SYNC_TOKEN) return err(503, "instagram_sync_not_configured");
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (timingSafeEqualStr(token, env.INSTAGRAM_SYNC_TOKEN)) return null;
  if (env.OWNER_TOKEN && timingSafeEqualStr(token, env.OWNER_TOKEN)) return null;
  return err(401, "unauthorized");
}

// POST /instagram/contacts/catalog — substitui o catálogo inteiro.
export async function handleIgCatalogPush(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  const contacts = sanitizeIgCatalog(body);
  if (!contacts) return err(400, "contacts must be an array of {igsid, username|name}");
  const catalog: IgCatalog = { contacts, pushed_at: new Date().toISOString() };
  await env.CACHE.put(IGCONTACTS_KV.catalog, JSON.stringify(catalog));
  return json({ ok: true, contacts: contacts.length });
}

// GET /instagram/contacts/config — allowlist pro script.
export async function handleIgConfigGet(env: Env): Promise<Response> {
  const allowlist = (await readJsonKV<string[]>(env, IGCONTACTS_KV.allowlist)) ?? [];
  return json({ ok: true, allowlist });
}

// POST /instagram/contacts/import — conversas marcadas, com phone opcional (join
// do script na tabela compartilhada `contacts` do agente).
export async function handleIgImport(req: Request, env: Env): Promise<Response> {
  let body: { contacts?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (!Array.isArray(body.contacts)) return err(400, "contacts must be an array");
  const contacts: IgImportContact[] = [];
  for (const c of body.contacts) {
    const igsid = typeof (c as any)?.igsid === "string" ? (c as any).igsid.trim() : "";
    if (!igsid) return err(400, "each contact needs igsid");
    contacts.push({
      igsid,
      username: normalizeIgUsername((c as any)?.username),
      name: typeof (c as any)?.name === "string" ? (c as any).name : null,
      phone: typeof (c as any)?.phone === "string" ? (c as any).phone : null,
    });
  }
  return json(await importIgContacts(env, contacts));
}

// GET /instagram/contacts/dossier?entity_id=&igsid=&username=&phone= — leitura
// SOB DEMANDA do dossiê pra dentro da conversa (get_profile do mcp-api-ig).
// Não encontrado é 200 {found:false} (estado normal, não erro). Entidade privada
// devolve só o mínimo (id+nome+flag): dado sensível não desce pro canal da conversa
// — regra alinhada ao spec 61 (o sync token não é o dono).
export async function handleIgDossier(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const q = (k: string) => { const v = url.searchParams.get(k); return v && v.trim() ? v.trim() : null; };
  const username = normalizeIgUsername(q("username"));
  const keys = { entity_id: q("entity_id"), igsid: q("igsid"), username, phone: q("phone") };
  if (!keys.entity_id && !keys.igsid && !keys.username && !keys.phone) {
    return err(400, "need at least one of entity_id/igsid/username/phone");
  }
  const hit = await resolveIgEntity(env, keys);
  if (!hit) return json({ ok: true, found: false });

  const e = await env.DB.prepare(`SELECT * FROM entities WHERE id = ?`).bind(hit.id).first<any>();
  if (!e) return json({ ok: true, found: false });
  if (e.private === 1) {
    return json({ ok: true, found: true, matched_via: hit.matched_via, private: true,
      entity: { id: e.id, name: e.name } });
  }

  const [conns, events, channels] = await Promise.all([
    env.DB.prepare(
      `SELECT c.type, c.why, c.a_id, ea.name AS a_name, ea.kind AS a_kind, ea.private AS a_private,
              c.b_id, eb.name AS b_name, eb.kind AS b_kind, eb.private AS b_private
         FROM connections c
         JOIN entities ea ON ea.id = c.a_id
         JOIN entities eb ON eb.id = c.b_id
        WHERE c.a_id = ?1 OR c.b_id = ?1 LIMIT 25`
    ).bind(hit.id).all(),
    env.DB.prepare(
      `SELECT kind, ts, context, source FROM events
        WHERE entity_id = ? AND private = 0 ORDER BY ts DESC LIMIT 10`
    ).bind(hit.id).all(),
    getChannels(env, hit.id),
  ]);
  const connections = (conns.results || [])
    .filter((c: any) => (c.a_id === hit.id ? c.b_private : c.a_private) !== 1)
    .slice(0, 10)
    .map((c: any) => ({
      type: c.type, why: c.why,
      other: c.a_id === hit.id ? c.b_name : c.a_name,
      other_kind: c.a_id === hit.id ? c.b_kind : c.a_kind,
    }));
  let attributes: unknown = null;
  if (e.attributes) { try { attributes = JSON.parse(e.attributes); } catch { attributes = e.attributes; } }
  return json({
    ok: true, found: true, matched_via: hit.matched_via,
    entity: {
      id: e.id, name: e.name, category: e.category ?? null, company: e.company ?? null,
      role: e.role ?? null, phone: e.phone ?? null, email: e.email ?? null,
      last_contacted: e.last_contacted ?? null, source: e.source ?? null, attributes,
    },
    channels: channels.map((c) => ({ kind: c.kind, value: c.value, href: channelHref(c.kind, c.value) })),
    connections,
    recent_events: events.results || [],
  });
}

// POST /instagram/contacts/push — escrita POR INTENÇÃO (tool push_to_vault do
// mcp-api-ig). SEM allowlist: o gate é a decisão deliberada do agente que conversa.
// category no body é REJEITADA — mudar categoria é curadoria manual do dono.
export async function handleIgPush(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return err(400, "invalid json"); }
  // JSON válido mas não-objeto (null/"str"/123/[]) quebraria o operador `in` → 500
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "body must be a JSON object");
  if ("category" in body) return err(400, "category is not accepted here — curadoria manual do dono");
  const input: IgPushInput = {
    entity_id: typeof body.entity_id === "string" ? body.entity_id : null,
    igsid: typeof body.igsid === "string" ? body.igsid : null,
    username: typeof body.username === "string" ? body.username : null,
    name: typeof body.name === "string" ? body.name : null,
    phone: typeof body.phone === "string" ? body.phone : null,
    photo_url: typeof body.photo_url === "string" ? body.photo_url : null,
    profile: body.profile && typeof body.profile === "object" ? body.profile as IgPushInput["profile"] : null,
    context: typeof body.context === "string" ? body.context : null,
  };
  const r = await pushIgContact(env, input, ctx);
  return json(r, { status: r.ok ? 200 : r.error === "igsid_link_conflict" ? 409 : 400 });
}

// GET /instagram/status — visão pro painel do Brain.
export async function handleIgStatus(env: Env): Promise<Response> {
  const [catalog, allowlist, lastRun] = await Promise.all([
    readJsonKV<IgCatalog>(env, IGCONTACTS_KV.catalog),
    readJsonKV<string[]>(env, IGCONTACTS_KV.allowlist),
    readJsonKV<Record<string, unknown>>(env, IGCONTACTS_KV.lastRun),
  ]);
  let linked = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM instagram_links").first<{ n: number }>();
    linked = row?.n ?? 0;
  } catch { /* tabela ainda não provisionada — status degrada pra 0 */ }
  return json({
    ok: true,
    configured: !!env.INSTAGRAM_SYNC_TOKEN,
    catalog: catalog?.contacts ?? [],
    catalog_pushed_at: catalog?.pushed_at ?? null,
    allowlist: Array.isArray(allowlist) ? allowlist : [],
    // Mesmo racional do WhatsApp: painel pré-marca tudo enquanto o dono nunca salvou.
    allowlist_set: allowlist !== null,
    last_run: lastRun,
    contacts_linked: linked,
  });
}

// POST /instagram/allowlist {igsids: string[]} — painel escolhe QUAIS conversas
// entram no grafo. Vazio é válido (pausa sem apagar o já importado).
export async function handleIgAllowlistPost(req: Request, env: Env): Promise<Response> {
  let body: { igsids?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (!Array.isArray(body.igsids)) return err(400, "igsids must be an array");
  const igsids = body.igsids.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  if (igsids.length !== body.igsids.length) return err(400, "igsids must be non-empty strings");
  await env.CACHE.put(IGCONTACTS_KV.allowlist, JSON.stringify(igsids));
  return json({ ok: true, allowlist: igsids });
}
