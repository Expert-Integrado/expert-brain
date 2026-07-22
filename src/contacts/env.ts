// Env do Worker expert-contacts.
// Reúne os bindings da API de entidades (DB/AI/VECTORIZE/MEDIA) + os bindings do
// Expert Console co-hospedado (ASSETS/CACHE + secrets de login e tokens de vault).
export interface Env {
  // --- API de entidades (Contacts) ---
  DB: D1Database;
  AI: Ai;
  VECTORIZE?: VectorizeIndex;
  MEDIA?: R2Bucket;
  OWNER_TOKEN: string;
  PIPEDRIVE_API_KEY?: string; // cron de manutenção: sync incremental do CRM (secret; enviado via header x-api-token, nunca em URL)
  MAINT_MAX_PERSONS?: string; // teto de persons por invocação do cron (spec 10-backend/22; default 500)

  // --- Google Contacts sync, mão única Google→Contacts (specs/google-contacts-sync.md) ---
  GOOGLE_CLIENT_ID?: string;     // FALLBACK (wrangler secret) — a fonte primária é o KV gsync:client gravado pelo painel do Brain (POST /google/client); painel salvo vence o env
  GOOGLE_CLIENT_SECRET?: string; // idem (wrangler secret)
  GSYNC_MAX_PERSONS?: string;    // teto de pessoas processadas por invocação (default 300)
  GSYNC_PUSH_MAX?: string;       // teto de pushes vault→Google por drain do write-back (default 25)
  GSYNC_REDIRECT_AFTER?: string; // destino do browser pós /google/callback (default: /app/contacts do Brain em prod)

  // --- Integração OPCIONAL WhatsApp Agent, grupos → grafo (specs/whatsapp-groups-sync.md) ---
  WHATSAPP_SYNC_TOKEN?: string; // Bearer do script de push (wrangler secret). AUSENTE = integração desligada (rotas do script respondem 503)

  // --- Integração OPCIONAL Instagram Agent, conversas → contatos (specs/instagram-contacts-sync.md) ---
  INSTAGRAM_SYNC_TOKEN?: string; // mesmo desenho do WHATSAPP_SYNC_TOKEN

  PUBLIC_BRAIN_URL?: string; // URL pública do console do Brain (wrangler var) — base dos hrefs de "Grupo em comum" no dossiê; ausente = href relativo

  // --- Expert Console (front multi-vault co-hospedado) ---
  ASSETS: Fetcher;        // Workers Assets — serve os bundles client de ./public
  CACHE: KVNamespace;     // cache do payload de grafo normalizado por vault:sourceHash
  OWNER_EMAIL?: string;       // login do Console
  OWNER_PASSWORD_HASH?: string; // hash PBKDF2 da passphrase do dono
  SESSION_SECRET?: string;      // chave HMAC dos cookies de sessão do Console
  VAULT_BRAIN_TOKEN?: string;   // Bearer (api-key do Brain) usado pelo adapter do vault brain
  BRAIN?: Fetcher;              // service binding pro Worker do Brain (fetch W2W — evita erro 1042)
  SSO_SECRET?: string;          // HMAC compartilhado c/ o Brain: /app/sso valida o handoff de /app/contacts-sso
  CONTACTS_PROXY_TOKEN?: string; // Bearer read-only do Brain (service binding). Escopo na API de entidades = allowlist canonica em src/auth/tokens.ts (spec 10-backend/24); rotas /app* tem allowlist propria em src/web/handler.ts.
  CONTACTS_WRITE_TOKEN?: string; // Bearer de ESCRITA escopado (spec 50-console-v2/57): autoriza SOMENTE POST /app/entity/event — o proxy de escrita do Brain usa pra registrar interação sem sessão de cookie. NUNCA confundir com CONTACTS_PROXY_TOKEN (read-only).
}

export interface AuthContext extends Record<string, unknown> {
  email: string;
  loggedInAt: number;
}
