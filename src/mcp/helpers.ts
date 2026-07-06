import type { Env, AuthContext } from '../env.js';

// Autoria de escrita (spec 17): id do PAT que autenticou (created_by/updated_by),
// ou `oauth:<email>` numa sessão OAuth (sem keyId). É o valor gravado nas colunas
// de autoria das tools de escrita. `auth` é sempre presente no registro das tools.
export function writeActor(auth: AuthContext): string {
  return auth.keyId ?? `oauth:${auth.email}`;
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
        return toolError(
          `Workers AI (the embedding model) returned an error: ${msg}. ` +
          `This is usually transient. The note was NOT saved because embedding failed before the database write (save_note validates inputs and generates the vector before committing). ` +
          `Wait a few seconds and retry the exact same save_note call — it is safe, there are no partial writes.`
        );
      }
      console.error('ExpertBrain tool error:', msg);
      return toolError(`Unexpected error: ${msg}. Check the input and try again. If the problem persists, this is probably a bug — report the timestamp ${new Date().toISOString()} to the maintainer.`);
    }
  };
}
