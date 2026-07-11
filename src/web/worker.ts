/**
 * Minimal worker entry used only for vitest SELF.fetch tests.
 * Dispatches /app/* requests through handleApp without loading the OAuth provider.
 * Also mirrors the PUBLIC /s/<token> share route (which in prod lives in
 * src/auth/handler.ts, outside /app) so the share tests can exercise it end-to-end.
 */
import type { Env } from '../env.js';
import { handleApp } from './handler.js';
import { handleSharePage, handleShareCommentPost, handleShareMedia, shareNotFound, SHARE_TOKEN_RE } from './share.js';
import { handleMailboxSummary, handleWhoami } from './mailbox-api.js';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/s/')) {
      const rest = url.pathname.slice('/s/'.length);
      if (rest.endsWith('/comment')) {
        const token = rest.slice(0, -'/comment'.length);
        if (req.method === 'POST' && SHARE_TOKEN_RE.test(token)) {
          return handleShareCommentPost(req, env, token);
        }
        return shareNotFound();
      }
      const mediaMatch = rest.match(/^([^/]+)\/media\/([^/]+)$/);
      if (mediaMatch) {
        if (req.method === 'GET' && SHARE_TOKEN_RE.test(mediaMatch[1])) {
          return handleShareMedia(req, env, mediaMatch[1], mediaMatch[2]);
        }
        return shareNotFound();
      }
      if (req.method === 'GET' && SHARE_TOKEN_RE.test(rest)) {
        return handleSharePage(req, env, rest);
      }
      return shareNotFound();
    }
    // Espelha o /api/mailbox/summary (spec 83) e o /api/whoami (spec 87), que em
    // prod vivem no auth/handler.ts.
    if (url.pathname === '/api/mailbox/summary' && req.method === 'GET') {
      return handleMailboxSummary(req, env);
    }
    if (url.pathname === '/api/whoami' && req.method === 'GET') {
      return handleWhoami(req, env);
    }
    const res = await handleApp(req, env);
    if (res) return res;
    return new Response('Não encontrado', { status: 404 });
  },
};
