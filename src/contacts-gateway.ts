// Gateway da fusão expert-contacts → expert-brain (F2, plano joyful-petting-alpaca).
//
// O worker de contatos vendorizado em src/contacts/ roda IN-PROCESS aqui dentro:
// `ensureContactsBinding` injeta em env.CONTACTS um Fetcher que chama o router do
// contacts como função — os 21 call sites `env.CONTACTS.fetch('https://contacts'+
// path)` do Brain (proxies do console, tools MCP, mentions, digest) continuam
// intactos; só o transporte muda (W2W → chamada local). Allowlists dos Bearers
// CONTACTS_PROXY_TOKEN/CONTACTS_WRITE_TOKEN e a propagação de privacidade via
// X-Include-Private ficam literalmente idênticas.
//
// Regras de ativação (modo dual — rollback do cutover é só configuração):
//  - env.CONTACTS já presente (service binding real no wrangler.toml) → gateway
//    NÃO ativa; tudo se comporta como antes da fusão.
//  - DB_CONTACTS/KV_CONTACTS ausentes (instalação sem contatos) → gateway não
//    ativa; a degradação 503 de sempre continua respondendo por tudo.
import contactsWorker from './contacts/index.js';
import type { Env as ContactsEnv } from './contacts/env.js';
import { runMigrations as runContactsMigrations } from './contacts/db/migrate.js';
import type { Env } from './env.js';

// Módulo de contatos "instalado" = os dois recursos obrigatórios estão bound.
// (VECTORIZE/MEDIA são opcionais no contacts desde sempre — degradação própria.)
export function hasContactsModule(env: Env): boolean {
  return Boolean(env.DB_CONTACTS && env.KV_CONTACTS);
}

// Traduz o Env do Brain pro Env que o módulo vendorizado espera. O código em
// src/contacts/ NÃO foi alterado na fusão — ele segue lendo os nomes originais
// (DB/CACHE/VECTORIZE/MEDIA/OWNER_TOKEN...); este mapper é a única ponte.
// Deliberadamente NÃO mapeados: OWNER_EMAIL/OWNER_PASSWORD_HASH/SESSION_SECRET/
// SSO_SECRET/VAULT_BRAIN_TOKEN/BRAIN — pertencem ao console standalone do worker
// antigo, que morre na fusão (login/SSO agora são só os do Brain).
export function contactsEnvFrom(env: Env): ContactsEnv {
  return {
    DB: env.DB_CONTACTS!,
    AI: env.AI,
    VECTORIZE: env.VECTORIZE_CONTACTS,
    MEDIA: env.MEDIA_CONTACTS,
    OWNER_TOKEN: env.CONTACTS_OWNER_TOKEN ?? '',
    PIPEDRIVE_API_KEY: env.PIPEDRIVE_API_KEY,
    MAINT_MAX_PERSONS: env.MAINT_MAX_PERSONS,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GSYNC_MAX_PERSONS: env.GSYNC_MAX_PERSONS,
    GSYNC_PUSH_MAX: env.GSYNC_PUSH_MAX,
    GSYNC_REDIRECT_AFTER: env.GSYNC_REDIRECT_AFTER,
    WHATSAPP_SYNC_TOKEN: env.WHATSAPP_SYNC_TOKEN,
    INSTAGRAM_SYNC_TOKEN: env.INSTAGRAM_SYNC_TOKEN,
    // No worker único a URL pública do Brain É a base dos hrefs do dossiê.
    PUBLIC_BRAIN_URL: env.WORKER_URL,
    ASSETS: env.ASSETS,
    CACHE: env.KV_CONTACTS!,
    CONTACTS_PROXY_TOKEN: env.CONTACTS_PROXY_TOKEN,
    CONTACTS_WRITE_TOKEN: env.CONTACTS_WRITE_TOKEN,
  };
}

// ctx pra caminhos sem ExecutionContext real (Durable Object do MCP): waitUntil
// vira fire-and-forget — o trabalho best-effort (cache de grafo, evento de
// menção) roda enquanto a request do DO estiver viva, e falha é engolida como
// sempre foi (os call sites já tratam esses efeitos como não-fatais).
function looseCtx(): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) { promise.catch(() => {}); },
    passThroughOnException() {},
    props: undefined,
  } as unknown as ExecutionContext;
}

// Injeta o Fetcher in-process em env.CONTACTS quando o módulo está bound e não
// há service binding real. Chamar mais de uma vez é inofensivo.
export function ensureContactsBinding(env: Env, ctx?: ExecutionContext): void {
  if (env.CONTACTS) return;
  if (!hasContactsModule(env)) return;
  const cEnv = contactsEnvFrom(env);
  const effectiveCtx = ctx ?? looseCtx();
  env.CONTACTS = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      contactsWorker.fetch(new Request(input as Request | string, init), cEnv, effectiveCtx),
  } as Fetcher;
}

// Provisiona o schema do vault de contatos (11 migrations, _migrations própria,
// no D1 PRÓPRIO — zero colisão com o schema do Brain). Idempotente como tudo
// no padrão /setup/provision.
export async function provisionContacts(env: Env): Promise<void> {
  if (!hasContactsModule(env)) return;
  await runContactsMigrations(contactsEnvFrom(env));
}

// ── Rotas públicas do módulo no worker único ─────────────────────────────────
// Namespaces de integração ficam nos MESMOS paths (consumidores externos —
// instagram-agent, scripts do whatsapp-agent, callback do Google — só trocam a
// base URL). CRÍTICO: o Request original segue SEM reescrita de URL — o contacts
// deriva a redirect URI do OAuth do Google de `new URL(req.url).origin`, que
// agora é a origin real do Brain.
// CONTRATO DE NAMESPACE: estes prefixos são RESERVADOS pro módulo de contatos;
// o Brain nunca deve registrar rota própria neles (teste-guarda na suíte).
const CONTACTS_PUBLIC_PREFIXES = ['/google/', '/whatsapp/', '/instagram/', '/pipedrive/'] as const;

export async function handleContactsApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  if (!hasContactsModule(env)) return null;
  const url = new URL(req.url);
  const path = url.pathname;

  if (CONTACTS_PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
    return contactsWorker.fetch(req, contactsEnvFrom(env), ctx);
  }

  // API de entidades sob o prefixo /contacts/* (evita colisão com /setup/* e
  // /status do Brain): strip do prefixo e despacho pro router do contacts.
  if (path === '/contacts' || path.startsWith('/contacts/')) {
    const sub = path.slice('/contacts'.length) || '/';
    // O console standalone do worker antigo morre na fusão: as PÁGINAS /app*
    // dele não são servidas publicamente. As rotas de DADOS /app/graph/* etc.
    // continuam vivas, mas SÓ via adapter in-process (painel do Brain) — nunca
    // pela URL pública.
    if (sub === '/app' || sub.startsWith('/app/')) {
      return new Response('not found', { status: 404 });
    }
    const target = new URL(url);
    target.pathname = sub;
    return contactsWorker.fetch(new Request(target.toString(), req), contactsEnvFrom(env), ctx);
  }

  return null;
}
