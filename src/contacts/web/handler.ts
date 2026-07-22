// Router do Expert Console (co-hospedado no Worker expert-contacts).
// Casa tudo sob /app*. CONGELADO após a Fase 0 — os workstreams preenchem só o
// corpo dos seus módulos (graph-api, adapters, console-page), NÃO tocam aqui.
//
// Fase 0 implementa de verdade: /app/login (GET/POST), /app/logout (POST) e o
// serviço de bundles (/app/<name>.bundle.js via ASSETS). As rotas de feature
// (graph/data, graph/meta, graph/link, entity, graph page) são stubs 501 até os
// WS correspondentes entrarem.

import type { Env } from '../env';
import { timingSafeEqualStr } from '../auth/tokens';
import { requireSession } from './session';
import { handleLoginGet, handleLoginPost, handleLogoutPost } from './login';
import { handleSso } from './sso';
import { handleGraphData, handleGraphMeta, handleGraphLink } from './graph-api.js';
import { handleEntityDetail } from './detail.js';
import { handleEntityUpdate, handleChannelDelete, handleEntityPrivate } from './entity-update.js';
import { handleEntityEventsList, handleEntityEventCreate, handleEventsRecent } from './events.js';
import { handleEntityNeighbors } from './neighbors.js';
import { handleGroupGraph } from './group-graph.js';
import { handleGraphPage, handleConfigPage } from './console-page.js';
import { handleBackupRun, handleExportGet } from './backup.js';
import { handleGetMedia } from '../media.js';

const notImplemented = () =>
  new Response(JSON.stringify({ ok: false, error: 'not_implemented' }), {
    status: 501,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// Bundles client são servidos via Workers Assets (./public). Cache imutável:
// o `?v=<hash>` (gerado pelo build) busta sozinho quando o conteúdo muda.
async function serveBundle(req: Request, env: Env, name: string): Promise<Response> {
  const assetReq = new Request(new URL(`/${name}`, req.url).toString(), req);
  const res = await env.ASSETS.fetch(assetReq);
  if (res.status === 404) {
    return new Response('bundle not found', { status: 404 });
  }
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('content-type', 'application/javascript; charset=utf-8');
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Trata as rotas do Console (/app*). Retorna a Response quando casar, ou `null`
 * pra o index.ts seguir com o roteamento da API de entidades.
 */
// Bearer do header em comparação constante (util canônico em src/auth/tokens.ts,
// spec 10-backend/24 — o loop XOR inline que vivia duplicado aqui foi extraído).
function bearerMatches(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return timingSafeEqualStr(m[1].trim(), expected);
}

// Proxy de LEITURA do Brain (allowlist própria das rotas /app*, ver handleApp).
function proxyTokenOk(req: Request, env: Env): boolean {
  return bearerMatches(req, env.CONTACTS_PROXY_TOKEN);
}

// Proxy de ESCRITA do Brain (spec 50-console-v2/57 §3) — token DIFERENTE do
// CONTACTS_PROXY_TOKEN (read-only). Autoriza SOMENTE POST /app/entity/event
// (allowlist de 1 path, ver handleApp).
function writeTokenOk(req: Request, env: Env): boolean {
  return bearerMatches(req, env.CONTACTS_WRITE_TOKEN);
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleApp(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path !== '/app' && !path.startsWith('/app/')) return null;

  // /app → grafo
  if (path === '/app') {
    return new Response(null, { status: 302, headers: { location: '/app/graph' } });
  }

  // --- Rotas públicas (sem sessão) ---

  // Login
  if (path === '/app/login') {
    if (method === 'GET') return handleLoginGet(req);
    if (method === 'POST') return handleLoginPost(req, env);
    return new Response('method not allowed', { status: 405 });
  }

  // SSO — handoff assinado vindo do Brain (/app/contacts-sso). Público: a confiança
  // é a assinatura HMAC (SSO_SECRET). Eric só tem o login do Brain; isto cria a
  // sessão do Console sem ele digitar senha aqui.
  if (path === '/app/sso' && method === 'GET') return handleSso(req, env);

  // Bundles — públicos (são estáticos, sem dado sensível). /app/<name>.bundle.js
  const bundleMatch = path.match(/^\/app\/([a-z0-9-]+\.bundle\.js)$/i);
  if (bundleMatch) {
    if (method !== 'GET') return new Response('method not allowed', { status: 405 });
    return serveBundle(req, env, bundleMatch[1]);
  }

  // Leitura do grafo via Bearer (CONTACTS_PROXY_TOKEN) — usado pelo service binding
  // do Brain pra embutir o vault contacts DENTRO da UI do Brain (/app/contacts).
  // Aditivo: sem Bearer válido, segue pro gate de sessão abaixo (browser intacto).
  // /app/entity, /app/entity/events, /app/entity/neighbors e /app/events/recent
  // entram no mesmo guarda-chuva read-only: a página própria do contato no Brain
  // (spec 50-console-v2/56) precisa do detalhe, da timeline paginada E da vizinhança
  // de 1º/2º nível via proxy; a home/journal (spec 65) precisam do feed global.
  if (
    method === 'GET' &&
    (path === '/app/graph/data' || path === '/app/graph/meta' || path === '/app/entity' || path === '/app/entity/events' || path === '/app/entity/neighbors' || path === '/app/entity/group-graph' || path === '/app/events/recent') &&
    proxyTokenOk(req, env)
  ) {
    if (path === '/app/entity') return handleEntityDetail(req, env);
    if (path === '/app/entity/events') return handleEntityEventsList(req, env);
    if (path === '/app/entity/neighbors') return handleEntityNeighbors(req, env);
    if (path === '/app/entity/group-graph') return handleGroupGraph(req, env);
    if (path === '/app/events/recent') return handleEventsRecent(req, env);
    return path === '/app/graph/data' ? handleGraphData(req, env) : handleGraphMeta(req, env);
  }

  // Escrita ESCOPADA via Bearer (CONTACTS_WRITE_TOKEN) — usada pelo proxy de escrita
  // do Brain (POST /app/contacts/entity/event) pra registrar interação sem sessão de
  // cookie. Allowlist de 1 PATH só (spec 50-console-v2/57): correto aqui, 401 em
  // qualquer outro path/método — NUNCA cai pro gate de sessão (fail-closed).
  if (writeTokenOk(req, env)) {
    if (path === '/app/entity/event' && method === 'POST') return handleEntityEventCreate(req, env, ctx);
    return unauthorized();
  }
  // Bearer PRESENTE nesse path mas ERRADO (ex.: CONTACTS_PROXY_TOKEN read-only, ou
  // lixo) — 401 explícito, nunca cai pro fluxo de sessão (que devolveria 302 e
  // mascararia o uso indevido do token). Critério de aceite: o proxy token
  // read-only NÃO ganha poder novo mesmo tentado aqui.
  if (path === '/app/entity/event' && method === 'POST' && req.headers.get('authorization')) {
    return unauthorized();
  }

  // --- A partir daqui exige sessão ---
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  // Logout
  if (path === '/app/logout' && method === 'POST') {
    return handleLogoutPost(req, env);
  }

  // Página do grafo (shell + canvas) — WS-1
  if (path === '/app/graph' && method === 'GET') return handleGraphPage(req, env);

  // Config (logout/sobre/troca de vault default) — WS-1
  if (path === '/app/config' && method === 'GET') return handleConfigPage(req, env);

  // Camada de vault API — WS-2
  if (path === '/app/graph/data' && method === 'GET') return handleGraphData(req, env);
  if (path === '/app/graph/meta' && method === 'GET') return handleGraphMeta(req, env);
  if (path === '/app/graph/link' && method === 'POST') return handleGraphLink(req, env);

  // Mídia (avatares) atrás da SESSÃO — espelho de GET /media/:hash da API
  // (spec 20-frontend/24). O <img> do browser não manda Bearer e o cookie tem
  // Path=/app, então a rota da API sempre respondia 401 pro painel. O payload
  // segue emitindo /media/<hash> (canônico); o client reescreve pro espelho.
  const mediaMatch = path.match(/^\/app\/media\/([0-9a-f]{64})$/i);
  if (mediaMatch && method === 'GET') return handleGetMedia(mediaMatch[1], env);

  // Detalhe da entidade (painel) — WS-3/WS-4
  if (path === '/app/entity' && method === 'GET') return handleEntityDetail(req, env);

  // Timeline paginada de interações + registro manual (spec 50-console-v2/57).
  // Sessão obrigatória (gate acima) — o caminho Bearer (leitura/escrita) já foi
  // tratado ANTES do gate de sessão, mais acima.
  if (path === '/app/entity/events' && method === 'GET') return handleEntityEventsList(req, env);
  if (path === '/app/entity/event' && method === 'POST') return handleEntityEventCreate(req, env, ctx);

  // Vizinhança de 1º/2º nível (spec 50-console-v2/56) — sessão obrigatória (gate
  // acima); o caminho Bearer read-only já foi tratado ANTES do gate de sessão.
  if (path === '/app/entity/neighbors' && method === 'GET') return handleEntityNeighbors(req, env);
  if (path === '/app/entity/group-graph' && method === 'GET') return handleGroupGraph(req, env);

  // Feed global de interações (spec 50-console-v2/65) — sessão obrigatória (gate
  // acima); o caminho Bearer read-only (proxy do Brain) já foi tratado ANTES do
  // gate de sessão, mas o console standalone também usa esta rota via cookie.
  if (path === '/app/events/recent' && method === 'GET') return handleEventsRecent(req, env);

  // Edição de contato pelo Console (spec 30-features/36 fase 3). Sessão obrigatória
  // (já validada acima) — reusa updateEntityFields/normalizeCategory/reembed do
  // write-path REST. Concorrência via expected_updated_at → 409.
  if (path === '/app/entity/update' && method === 'POST') return handleEntityUpdate(req, env);

  // Remoção de canal da cartela (spec 55) — sessão obrigatória (gate acima).
  if (path === '/app/entity/channel_delete' && method === 'POST') return handleChannelDelete(req, env);

  // Toggle do selo de privacidade (spec 61) — SESSÃO obrigatória (gate acima). É o
  // único lugar que DESMARCA. O caminho Bearer (proxy/write) já retornou antes do
  // gate de sessão, então um proxy token nunca chega aqui (fail-closed).
  if (path === '/app/entity/private' && method === 'POST') return handleEntityPrivate(req, env);

  // URL própria também no console standalone (spec 56 §4): GET /app/entity/<id>
  // (path param) resolve pro MESMO handleEntityDetail — link direto/copiável pra
  // quem usa o console standalone. Regex checado por ÚLTIMO dentre as rotas
  // /app/entity/* (acima) pra não engolir os paths exatos (events/event/update/
  // channel_delete/neighbors), que já retornaram antes se casaram.
  const entityPathMatch = path.match(/^\/app\/entity\/([A-Za-z0-9_-]+)$/);
  if (entityPathMatch && method === 'GET') return handleEntityDetail(req, env, entityPathMatch[1]);

  // Backup (spec 50-console-v2/67): snapshot manual + export ZIP. Sessão
  // obrigatória (gate acima) — deliberadamente FORA do allowlist do
  // CONTACTS_PROXY_TOKEN e sem rota pública: o export contém o vault INTEIRO.
  if (path === '/app/backup/run' && method === 'POST') return handleBackupRun(req, env);
  if (path === '/app/export' && method === 'GET') return handleExportGet(req, env);

  // Casou /app* mas nenhuma rota — 404 dentro do namespace do Console.
  return new Response(JSON.stringify({ ok: false, error: 'route_not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
