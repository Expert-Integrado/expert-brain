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
}

export interface AuthContext extends Record<string, unknown> {
  email: string;
  loggedInAt: number;
}
