import type { Env, AuthContext } from '../env.js';
import { hasScope } from '../auth/api-keys.js';

// Autoria de escrita (spec 17): id do PAT que autenticou (created_by/updated_by),
// ou `oauth:<email>` numa sessão OAuth (sem keyId). É o valor gravado nas colunas
// de autoria das tools de escrita. `auth` é sempre presente no registro das tools.
export function writeActor(auth: AuthContext): string {
  return auth.keyId ?? `oauth:${auth.email}`;
}

// Visibilidade de nota privada nos read paths MCP (spec 30-features/31). FAIL-CLOSED:
// só vê privadas quem é a sessão OAuth do dono (sem keyId — marcador de "dono logado",
// ver spec 17) OU um PAT que carrega o escopo `private` no CSV. PAT `full` SEM `private`
// NÃO vê nota privada — `full` dá CRUD, não confidência. `auth` ausente (chamadas de
// teste que registram a tool sem contexto) → false (o mais restritivo).
export function canSeePrivate(auth?: AuthContext): boolean {
  if (!auth) return false;
  return auth.keyId === undefined || hasScope(auth.scopes, 'private');
}

export function noteUrl(env: Env, id: string): string {
  const base = env.WORKER_URL?.replace(/\/$/, '') ?? '';
  return `${base}/app/notes/${id}`;
}

export type ToolResult =
  | { content: Array<{ type: 'text'; text: string }> }
  | { content: Array<{ type: 'text'; text: string }>; isError: true };

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function toolSuccess(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function safeToolHandler<A extends unknown[]>(
  fn: (...args: A) => Promise<ToolResult>
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('D1_ERROR') || msg.includes('SQLITE_ERROR')) {
        console.error('ExpertBrain D1 error:', msg);
        return toolError(
          `Internal error in the vault database (D1). Probably transient — wait a few seconds and try again. ` +
          `If it persists, report the timestamp ${new Date().toISOString()} and the attempted action to the maintainer.`
        );
      }
      if (msg.includes('VECTORIZE') || msg.includes('Vectorize') || msg.includes('vectorize')) {
        console.error('ExpertBrain Vectorize error:', msg);
        return toolError(
          `Vectorize (the semantic search index) returned an error: ${msg}. ` +
          `This can be transient (index is eventually consistent and occasionally throttles). ` +
          `If this happened during save_note, the note itself was written to D1 but the vector may not be queryable — the note is still accessible via get_note(id) and expand(id), just not via recall() until re-embedded. ` +
          `If this happened during recall, wait ~30s and try again; if it persists, fall back to describing your answer without vault recall and warn the user.`
        );
      }
      if (msg.includes('@cf/baai') || msg.includes('Workers AI') || msg.includes('AiError')) {
        console.error('ExpertBrain Workers AI error:', msg);
        // Persistência depende da ORDEM de cada tool (spec 10-backend/23): save_note
        // embeda ANTES de gravar (nada persistiu, retry seguro); update_note grava o
        // D1 ANTES de embedar (a edição pode ter persistido com vetor stale). A
        // mensagem NÃO pode afirmar "nothing was saved" universalmente.
        return toolError(
          `Workers AI (the embedding model) returned an error: ${msg}. ` +
          `This is usually transient. Whether data was persisted depends on the tool: ` +
          `save_note embeds BEFORE writing (nothing saved — safe to retry the same call); ` +
          `update_note writes to the database BEFORE embedding (the edit may have persisted with a stale vector). ` +
          `Do NOT blindly retry a write. First call get_note(id) to check what persisted; ` +
          `if the edit is there, call reembed(id) to fix the vector instead of repeating the update.`
        );
      }
      console.error('ExpertBrain tool error:', msg);
      return toolError(`Unexpected error: ${msg}. Check the input and try again. If the problem persists, this is probably a bug — report the timestamp ${new Date().toISOString()} to the maintainer.`);
    }
  };
}
