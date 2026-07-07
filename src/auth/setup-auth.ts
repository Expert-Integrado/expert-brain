import type { Env } from '../env.js';
import { authorizeBearer, tokenMatches } from '../web/bearer-auth.js';
import { readCookie, verifySession } from '../web/session.js';

// Gate dos endpoints /setup/* (spec 10-backend/18). Autorizado quando o request
// traz QUALQUER um:
//  - Bearer GRAPH_EXPORT_TOKEN ou TASK_REMINDER_TOKEN (authorizeBearer, escopo
//    'tasks' aceita os dois — são os bearers operacionais do dono);
//  - Bearer SETUP_TOKEN (secret efêmero que o wizard/deploy grava no Worker);
//  - cookie de sessão eb_session válido (dono logado no console).
// NÃO usa requireSession (que responde redirect 302) — os callers respondem
// 401 JSON.
export async function isAuthorizedForSetup(req: Request, env: Env): Promise<boolean> {
  if (await authorizeBearer(req, env, 'tasks')) return true;

  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m && (await tokenMatches(m[1].trim(), env.SETUP_TOKEN))) return true;

  if (env.SESSION_SECRET) {
    const cookie = readCookie(req.headers.get('cookie'), 'eb_session');
    if (cookie) {
      const session = await verifySession(cookie, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
      if (session) return true;
    }
  }
  return false;
}
