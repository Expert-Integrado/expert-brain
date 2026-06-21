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
  MCP_OBJECT: DurableObjectNamespace;
  WORKER_URL?: string;
  // Bearer token que libera leitura/escrita das rotas /app/graph/* sem sessão de
  // browser. Usado pelo Expert Console (adapter do vault brain) pra consumir o
  // grafo via HTTP. Aditivo: se ausente, só a sessão de cookie autoriza.
  GRAPH_EXPORT_TOKEN?: string;
}

export interface AuthContext extends Record<string, unknown> {
  email: string;
  loggedInAt: number;
}
