// Timeline de interações do Console (spec 50-console-v2/57):
//   GET  /app/entity/events?id=&offset=&limit=  — leitura paginada (sessão OU Bearer
//        CONTACTS_PROXY_TOKEN read-only, allowlist em handler.ts).
//   POST /app/entity/event  { entity_id, kind, context?, ts? } — registro manual
//        (sessão do console standalone OU Bearer CONTACTS_WRITE_TOKEN, o proxy de
//        escrita do Brain — allowlist de 1 path só, handler.ts).
//
// Ambas as rotas delegam a lógica de negócio pro núcleo compartilhado recordEvent
// (src/events.ts) — mesma validação/insert/last_contacted/reembed do REST POST /event.

import type { Env } from "../env.js";
import { recordEvent, type RecordEventInput } from "../events.js";
import { callerSeesPrivate } from "./privacy.js";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function parsePositiveInt(raw: string | null, def: number, max?: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  const v = Math.floor(n);
  return max != null ? Math.min(v, max) : v;
}

// GET /app/entity/events?id=<id>&offset=0&limit=30 — página estável ordenada por
// ts DESC (empate desambiguado por id DESC, já que ts pode repetir no mesmo segundo).
export async function handleEntityEventsList(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return json({ ok: false, error: "id_required" }, { status: 400 });

  const offset = parsePositiveInt(url.searchParams.get("offset"), 0);
  const limit = parsePositiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;

  // Privacidade (spec 61): entidade privada → 404 pra quem não vê privados (não
  // vazar existência via timeline). Eventos privados somem da lista e do `total`.
  const includePrivate = await callerSeesPrivate(req, env);
  const entity = await env.DB.prepare("SELECT id, private FROM entities WHERE id = ?")
    .bind(id).first<{ id: string; private: number }>();
  if (!entity || (!includePrivate && entity.private === 1)) {
    return json({ ok: false, error: "entity_not_found", id }, { status: 404 });
  }

  const privEv = includePrivate ? "" : " AND private = 0";
  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE entity_id = ?${privEv}`)
    .bind(id)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB
    .prepare(
      `SELECT id, kind, ts, context, source, private FROM events
        WHERE entity_id = ?${privEv} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(id, limit, offset)
    .all();

  return json({ ok: true, id, total, offset, limit, events: rows.results ?? [] });
}

// GET /app/events/recent?offset=0&limit=30 — feed GLOBAL de interações (todas as
// entidades), spec 50-console-v2/65 §1. Alimenta o card "Últimas interações" da home
// e o journal do Brain. JOIN em entities só pro nome de exibição (entity_name é CACHE
// de leitura, não normalizado). Privacidade (spec 61): sem include-private, evento
// privado OU evento de entidade privada saem da lista E do `total` — nunca vazam
// mesmo que o dono nunca tenha rodado a 61 (a query já reflete o schema atual, que
// tem as colunas `private` desde a migration 0007).
export async function handleEventsRecent(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0);
  const limit = parsePositiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;

  const includePrivate = await callerSeesPrivate(req, env);
  const privFilter = includePrivate ? "" : " AND e.private = 0 AND en.private = 0";

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM events e JOIN entities en ON en.id = e.entity_id WHERE 1=1${privFilter}`)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB
    .prepare(
      `SELECT e.id AS id, e.entity_id AS entity_id, en.name AS entity_name, e.kind AS kind, e.ts AS ts, e.context AS context
         FROM events e JOIN entities en ON en.id = e.entity_id
         WHERE 1=1${privFilter}
         ORDER BY e.ts DESC, e.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all();

  return json({ ok: true, total, offset, limit, events: rows.results ?? [] });
}

// POST /app/entity/event — ver cabeçalho do arquivo. `ctx` (ExecutionContext) é
// opcional: o handler.ts do Console hoje não propaga ExecutionContext pra handleApp,
// então o reembed (só quando kind='note') roda inline nesse caminho — correto, só
// mais lento que o waitUntil do REST.
export async function handleEntityEventCreate(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const input: RecordEventInput = {
    entity_id: String(body?.entity_id ?? "").trim(),
    kind: String(body?.kind ?? ""),
    context: body?.context != null ? String(body.context) : null,
    ts: body?.ts != null ? String(body.ts) : null,
    source: body?.source != null ? String(body.source) : null,
    // Privacidade (spec 61): checkbox "privada" do form / flag do MCP. Evento privado
    // fica fora da timeline do proxy sem header e NUNCA entra no embedding.
    private: body?.private === true,
  };

  const result = await recordEvent(env, input, ctx);
  switch (result.status) {
    case "missing_fields":
      return json({ ok: false, error: "entity_id and kind required" }, { status: 400 });
    case "invalid_kind":
      return json({ ok: false, error: `invalid kind: ${input.kind}`, allowed: [...result.allowed] }, { status: 400 });
    case "invalid_source":
      return json({ ok: false, error: `invalid source: ${input.source}`, allowed: [...result.allowed] }, { status: 400 });
    case "not_found":
      return json({ ok: false, error: "entity_not_found", id: input.entity_id }, { status: 404 });
    case "ok":
      return json({ ok: true, id: result.id });
    default:
      // Inalcançável — RecordEventResult é união fechada; guarda de exaustividade.
      return json({ ok: false, error: "unexpected recordEvent status" }, { status: 500 });
  }
}
