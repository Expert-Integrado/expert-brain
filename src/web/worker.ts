/**
 * Minimal worker entry used only for vitest SELF.fetch tests.
 * Dispatches /app/* requests through handleApp without loading the OAuth provider.
 */
import type { Env } from '../env.js';
import { handleApp } from './handler.js';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const res = await handleApp(req, env);
    if (res) return res;
    return new Response('Não encontrado', { status: 404 });
  },
};
