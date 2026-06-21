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
}

export interface AuthContext extends Record<string, unknown> {
  email: string;
  loggedInAt: number;
}
