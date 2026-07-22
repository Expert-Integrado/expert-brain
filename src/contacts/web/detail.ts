// Detalhe da entidade pro painel lateral do Console (T3).
//
// GET /app/entity?vault=&id= — resolve o adapter no registry VAULTS (mesmo registro
// que o graph-api faz, importado aqui como side-effect pra garantir 'contacts'
// presente), chama adapter.fetchEntity(env, id) e devolve EntityDetail JSON.
//
// 404 se o vault não existe (vault_not_found) OU se a entidade não existe
// (entity_not_found). O fetchEntity do adapter lança quando a entidade some — a
// distinção fica no detail do erro pra o client renderar uma msg amigável.

import type { Env } from '../env.js';
import { VAULTS, type EntityDetail } from '../vaults/types.js';
import { callerSeesPrivate } from './privacy.js';
// Side-effect: registra o adapter 'contacts' no VAULTS (mesmo módulo que o handler
// já carrega). Importado aqui pra garantir o registro mesmo que esta rota seja
// avaliada antes do graph-api em alguma ordem de import.
import './graph-api.js';

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...init?.headers,
    },
  });

// GET /app/entity?vault=&id= — ou GET /app/entity/<id> (path param, spec
// 50-console-v2/56 §4): `pathId`, quando presente, tem prioridade sobre o query
// param `id` — permite link direto pro console standalone (vault sempre 'contacts'
// nesse caminho, já que a rota de path só existe do lado do Worker de contatos).
export async function handleEntityDetail(req: Request, env: Env, pathId?: string): Promise<Response> {
  const url = new URL(req.url);
  const vault = (url.searchParams.get('vault') || 'contacts').trim() || 'contacts';
  const id = (pathId ?? url.searchParams.get('id') ?? '').trim();

  const adapter = VAULTS[vault];
  if (!adapter) return json({ ok: false, error: 'vault_not_found', vault }, { status: 404 });
  if (!id) return json({ ok: false, error: 'id_required' }, { status: 400 });

  // Privacidade (spec 61): entidade privada → mesmo 404 de inexistente pra quem não
  // vê privados (o adapter lança 'entity not found', tratado abaixo).
  const includePrivate = await callerSeesPrivate(req, env);
  let detail: EntityDetail;
  try {
    detail = await adapter.fetchEntity(env, id, includePrivate);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // fetchEntity lança 'entity not found' (contacts) quando o id não existe.
    if (/not found/i.test(msg)) {
      return json({ ok: false, error: 'entity_not_found', vault, id }, { status: 404 });
    }
    return json({ ok: false, error: 'fetch_entity_failed', detail: msg }, { status: 500 });
  }

  return json(detail);
}
