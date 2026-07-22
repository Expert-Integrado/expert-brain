// Camada de Vault API do Expert Console — liga o handler aos adapters.
//
// Resolve o vault de ?vault= (default 'contacts'), registra o adapter no registry
// exportado VAULTS (mutação — NÃO edita types.ts), parseia GraphParams/LinkBody e
// delega pro adapter. Cacheia o payload normalizado em env.CACHE.
//
// Cache: key = graph:<vault>:<sourceHash>:<paramsKey>, TTL 1h. O sourceHash (assinatura
// global das entidades+connections) entra na CHAVE, então qualquer escrita (REST/MCP:
// save_person/save_company/attach_media, createLink) auto-invalida o cache — a chave
// muda e o próximo hit é MISS. Entradas velhas expiram sozinhas pelo TTL. createLink
// também limpa o prefixo do vault explicitamente (escrita pelo próprio Console).

import type { Env } from '../env.js';
import { VAULTS, type GraphParams, type LinkBody } from '../vaults/types.js';
import { contactsAdapter, contactsSourceHash, contactsMeta, serializeGraphParams } from '../vaults/contacts.js';
import { brainAdapter } from '../vaults/brain.js';
import { callerSeesPrivate } from './privacy.js';

// Registra os adapters. contacts é in-process (lê env.DB direto); brain é remoto
// (HTTP + Bearer pro Worker do Expert Brain). +1 vault futuro = +1 entrada aqui.
VAULTS[contactsAdapter.id] = contactsAdapter;
VAULTS[brainAdapter.id] = brainAdapter;

const CACHE_TTL_SECONDS = 60 * 60; // 1h

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...init?.headers },
  });

function resolveVault(url: URL) {
  const vault = (url.searchParams.get('vault') || 'contacts').trim();
  const adapter = VAULTS[vault];
  return { vault, adapter };
}

function parseGraphParams(url: URL): GraphParams {
  const p: GraphParams = {};
  const q = url.searchParams.get('q');
  const focus = url.searchParams.get('focus');
  const depth = url.searchParams.get('depth');
  const all = url.searchParams.get('all');
  const limit = url.searchParams.get('limit');
  if (q) p.q = q;
  if (focus) p.focus = focus;
  if (depth) { const d = parseInt(depth, 10); if (Number.isFinite(d)) p.depth = d; }
  if (all === 'true' || all === '1') p.all = true;
  if (limit) { const l = parseInt(limit, 10); if (Number.isFinite(l)) p.limit = l; }
  return p;
}

// Assinatura global do vault pra chave de cache. O contacts expõe contactsSourceHash
// (agregados globais, sem subgrafo) sem mexer na interface congelada do VaultAdapter.
// Outros vaults (ex.: brain, via HTTP) não têm essa função → fallback estável que faz
// o cache cair só pelo TTL (sem auto-invalidação, mas sem quebrar).
async function vaultSourceHash(env: Env, vault: string): Promise<string> {
  if (vault === contactsAdapter.id) return contactsSourceHash(env);
  return 'na';
}

async function invalidateVaultCache(env: Env, vault: string): Promise<void> {
  try {
    const prefix = `graph:${vault}:`;
    let cursor: string | undefined;
    do {
      const res = await env.CACHE.list({ prefix, cursor });
      await Promise.all(res.keys.map((k) => env.CACHE.delete(k.name)));
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
  } catch (e: any) {
    console.error('[graph-api] cache invalidation failed', e?.message || e);
  }
}

// GET /app/graph/data?vault=&q=&focus=&depth=&all=&limit=
export async function handleGraphData(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { vault, adapter } = resolveVault(url);
  if (!adapter) return json({ ok: false, error: 'vault_not_found', vault }, { status: 404 });

  const params = parseGraphParams(url);
  // Privacidade (spec 61): a visibilidade do CALLER entra nos params ANTES de montar
  // a chave de cache (serializeGraphParams já a inclui) — nó privado só entra pro
  // dono, e o cache separa payload privado de público. Vale pros dois callers do
  // handler: proxy (Bearer + header) e sessão (dono).
  params.includePrivate = await callerSeesPrivate(req, env);
  // sourceHash na CHAVE → auto-invalidação por escrita (não só TTL). Computado ANTES
  // do lookup (agregados globais, query barata), não dentro do assemblePayload.
  const sourceHash = await vaultSourceHash(env, vault);
  const cacheKey = `graph:${vault}:${sourceHash}:${serializeGraphParams(params)}`;

  // Cache hit (TTL). Layout/posições estáveis dentro da janela.
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached) return json(cached, { headers: { 'x-cache': 'hit' } });
  } catch (e: any) {
    console.error('[graph-api] cache read failed', e?.message || e);
  }

  let payload;
  try {
    payload = await adapter.fetchGraph(env, params);
  } catch (e: any) {
    return json({ ok: false, error: 'fetch_graph_failed', detail: String(e?.message || e) }, { status: 500 });
  }

  // Não cacheia payload vazio (auto-cura quando o banco/Vectorize popularem).
  if (payload.nodes.length > 0) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
    } catch (e: any) {
      console.error('[graph-api] cache write failed', e?.message || e);
    }
  }
  return json(payload, { headers: { 'x-cache': 'miss' } });
}

// GET /app/graph/meta?vault= — counts + legend + lista leve (id,label) p/ palette.
// NÃO recomputa o grafo: consulta leve (SELECT id,name + COUNT(*)) via contactsMeta,
// sem forceatlas2 nem Vectorize. Outros vaults caem no fallback fetchGraph.
export async function handleGraphMeta(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { vault, adapter } = resolveVault(url);
  if (!adapter) return json({ ok: false, error: 'vault_not_found', vault }, { status: 404 });

  const includePrivate = await callerSeesPrivate(req, env);
  let list: Array<{ id: string; label: string }>;
  let counts: { nodes: number; edges: number };
  try {
    if (vault === contactsAdapter.id) {
      const meta = await contactsMeta(env, includePrivate);
      list = meta.list;
      counts = meta.counts;
    } else {
      // Vaults sem meta leve (ex.: brain via HTTP): deriva do subgrafo padrão.
      const payload = await adapter.fetchGraph(env, {});
      list = payload.nodes.map((n) => ({ id: n.id, label: n.label }));
      counts = { nodes: payload.nodes.length, edges: payload.edges.length };
    }
  } catch (e: any) {
    return json({ ok: false, error: 'meta_failed', detail: String(e?.message || e) }, { status: 500 });
  }

  return json({
    ok: true,
    vault,
    name: adapter.name,
    color: adapter.color,
    colorBy: adapter.colorBy,
    counts,
    legend: adapter.legend(),
    list,
  });
}

// POST /app/graph/link?vault= — cria aresta justificada e invalida o cache.
export async function handleGraphLink(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { vault, adapter } = resolveVault(url);
  if (!adapter) return json({ ok: false, error: 'vault_not_found', vault }, { status: 404 });

  let body: LinkBody;
  try {
    body = (await req.json()) as LinkBody;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  let result;
  try {
    result = await adapter.createLink(env, body);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  }

  await invalidateVaultCache(env, vault);
  return json(result);
}
