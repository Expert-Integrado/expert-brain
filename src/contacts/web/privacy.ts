// Selo de privacidade do vault de contatos (spec 50-console-v2/61).
//
// callerSeesPrivate(req, env) é a FONTE ÚNICA de decisão de visibilidade de
// entidades/eventos privados em TODOS os read paths GET (grafo, detalhe, timeline,
// vizinhos, REST). FAIL-CLOSED por default: só devolve `true` pra quem é o dono.
//
// Quem vê privados:
//   - Sessão do console (cookie mv_session válido) = dono → SIM.
//   - Bearer OWNER_TOKEN (REST/MCP local do dono)        → SIM.
//   - Bearer CONTACTS_PROXY_TOKEN + header X-Include-Private:1 → SIM.
//   - Bearer CONTACTS_PROXY_TOKEN SEM o header           → NÃO.
//   - Header X-Include-Private sem Bearer proxy VÁLIDO   → IGNORADO (NÃO).
//
// O header é como o Brain propaga o escopo do SEU caller (PAT com/sem `private`)
// downstream: o segredo continua sendo o token (quem tem o proxy token já lia 100%
// hoje); o header é auto-restrição do Brain por request e só é honrado quando o
// Bearer é o proxy token VÁLIDO — protege contra os callers do Brain, não contra
// vazamento do token em si (spec 61 item 2).

import type { Env } from '../env.js';
import { requireSession } from './session.js';

const INCLUDE_PRIVATE_HEADER = 'x-include-private';

function bearerToken(req: Request): string {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Comparação em tempo (quase) constante — mesmo padrão de proxyTokenOk/writeTokenOk
// (handler.ts). Difere no comprimento cedo, mas nunca compara por `===` de string.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// True se o caller deste request pode ver entidades/eventos com `private = 1`.
// Assíncrono porque a validação de sessão (HMAC do cookie) é async.
export async function callerSeesPrivate(req: Request, env: Env): Promise<boolean> {
  const token = bearerToken(req);

  // OWNER_TOKEN = dono (REST/MCP local) → vê tudo.
  if (env.OWNER_TOKEN && token && constantTimeEqual(token, env.OWNER_TOKEN)) return true;

  // Proxy token read-only: honra X-Include-Private:1 (Brain propagou o escopo do
  // caller dele). SÓ aqui o header tem efeito — em qualquer outro caso é ignorado.
  if (env.CONTACTS_PROXY_TOKEN && token && constantTimeEqual(token, env.CONTACTS_PROXY_TOKEN)) {
    return req.headers.get(INCLUDE_PRIVATE_HEADER) === '1';
  }

  // Sessão do console (dono) → vê tudo. Roda por último: só chega aqui quem não
  // veio por token conhecido (ex.: browser logado). Sem cookie válido → false.
  const session = await requireSession(req, env);
  return session.ok;
}
