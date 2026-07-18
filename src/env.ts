export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  OWNER_EMAIL?: string;
  OWNER_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  OAUTH_KV: KVNamespace;
  GRAPH_CACHE: KVNamespace;
  // Bucket R2 pra mídia das notas. Opcional: se ausente, os endpoints de mídia
  // respondem 503 (o resto do Brain funciona normal). Ver migration 0007_note_media.
  MEDIA?: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace;
  WORKER_URL?: string;
  // Bearer token que libera leitura/escrita das rotas /app/graph/* sem sessão de
  // browser. Usado pelo Expert Console (adapter do vault brain) pra consumir o
  // grafo via HTTP. Aditivo: se ausente, só a sessão de cookie autoriza.
  GRAPH_EXPORT_TOKEN?: string;
  // Bearer token escopado pro lembrete de tasks (cron na VPS) ler /app/tasks/data.
  // Separado do GRAPH_EXPORT_TOKEN de propósito: o cron tem sua própria credencial,
  // então rotacionar/revogar uma não afeta a outra (Expert Console x lembrete).
  TASK_REMINDER_TOKEN?: string;
  // Bearer que autoriza os endpoints /setup/* quando o vault JÁ está configurado
  // (spec 10-backend/18). Gerado pelo scripts/setup.mjs e enviado pelo
  // scripts/deploy.mjs no provision pós-deploy. Ausente → /setup/* aceita só
  // GRAPH_EXPORT_TOKEN/TASK_REMINDER_TOKEN ou sessão do dono.
  SETUP_TOKEN?: string;
  // Segredo HMAC compartilhado com o Worker do Expert Contacts pro SSO do nav:
  // /app/contacts-sso assina um handoff curto que o /app/sso do Console valida.
  // MESMO valor nos dois Workers. Ausente → o link cai no Console com login normal.
  SSO_SECRET?: string;
  // Service binding + Bearer pro Worker do Expert Contacts: /app/contacts (no Brain)
  // embute o grafo de contatos puxando /app/graph/{data,meta}?vault=contacts por trás.
  CONTACTS?: Fetcher;
  CONTACTS_PROXY_TOKEN?: string;
  // URL PÚBLICA do Worker expert-contacts (wrangler var). O service binding ignora
  // o hostname da URL, mas o contacts deriva a origin do request pra montar a
  // redirect URI do OAuth do Google — sem esta var o proxy manda "https://contacts"
  // e o Google recusa com redirect_uri_mismatch.
  CONTACTS_PUBLIC_URL?: string;
  // Bearer de ESCRITA escopado (spec 50-console-v2/57): o Brain usa pra registrar
  // interação (POST /app/contacts/entity/event) via service binding CONTACTS.
  // DIFERENTE do CONTACTS_PROXY_TOKEN (read-only) — o contacts autoriza esse token
  // SOMENTE nesse 1 path (allowlist do lado de lá). MESMO valor nos dois Workers.
  CONTACTS_WRITE_TOKEN?: string;
  // Auto-cancel de tasks mortas (spec 30-features/32 §4). Ausente/vazia = DESLIGADO
  // (default). Setada com N > 0: o cron diário cancela task open vencida há mais de
  // N dias E sem update há mais de N dias (reversível via update_task).
  TASK_AUTOCANCEL_AFTER_DAYS?: string;
  // Lembrete proativo de prazo (Fase 2): o cron do Worker (scheduled) manda um digest
  // diário das tasks que vencem hoje + atrasadas pro Telegram. Ausentes → o cron roda
  // mas NÃO envia (no-op seguro): fica dormente até os secrets serem setados.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  // Web Push (specs/50-console-v2/68): JWK P-256 completo (d/x/y) da chave VAPID,
  // setado via `wrangler secret put VAPID_PRIVATE_KEY`. A chave PÚBLICA é derivada
  // dos campos x/y — não existe segundo secret. Ausente → push desligado (no-op).
  VAPID_PRIVATE_KEY?: string;
  // Claim `sub` do JWT VAPID (contato do operador). Ausente → usa WORKER_URL.
  VAPID_SUBJECT?: string;
}

export interface AuthContext extends Record<string, unknown> {
  email: string;
  loggedInAt: number;
  // Escopos da credencial (spec 10-backend/17 + 30-features/31). Só presente em
  // sessões via PAT; ausente = 'full' (sessões OAuth existentes continuam com CRUD
  // completo). CSV (spec 31): base 'full'|'read' + escopos aditivos, hoje só
  // 'private'. Ex.: 'read', 'full,private'. `hasScope(scopes,'read')` faz o registry
  // NÃO registrar tools de escrita; `hasScope(scopes,'private')` libera ler notas
  // privadas nos read paths. Testar SEMPRE via hasScope, nunca por igualdade.
  scopes?: string;
  // Id do PAT que autenticou (api_keys.id) — grava autoria de escrita
  // (created_by/updated_by). Ausente em OAuth (usa-se `oauth:<email>`).
  keyId?: string;
}
