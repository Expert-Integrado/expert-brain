/**
 * Minimal worker entry used only for vitest SELF.fetch tests.
 * Dispatches /app/* requests through handleApp without loading the OAuth provider.
 * Also mirrors the PUBLIC /s/<token> share route (which in prod lives in
 * src/auth/handler.ts, outside /app) so the share tests can exercise it end-to-end.
 */
import type { Env } from '../env.js';
import { handleApp } from './handler.js';
import { handleSharePage, shareNotFound, SHARE_TOKEN_RE } from './share.js';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/s/')) {
      const token = url.pathname.slice('/s/'.length);
      if (req.method === 'GET' && SHARE_TOKEN_RE.test(token)) {
        return handleSharePage(req, env, token);
      }
      return shareNotFound();
    }
    const res = await handleApp(req, env);
    if (res) return res;
    return new Response('Não encontrado', { status: 404 });
  },
};
