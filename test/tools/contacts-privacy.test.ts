import { describe, it, expect } from 'vitest';
import { registerContactsTools } from '../../src/mcp/tools/contacts.js';
import type { AuthContext } from '../../src/env.js';

// Propagação do escopo `private` do CALLER do Brain pro Expert Contacts (spec
// 50-console-v2/61 §3). O Brain lê contatos via service binding CONTACTS + Bearer
// CONTACTS_PROXY_TOKEN (read-only). O header X-Include-Private:1 é como o Brain
// auto-restringe por request: só vai quando o caller (PAT/sessão) PODE ver privados
// (canSeePrivate). Aqui capturamos o header enviado ao contacts sob cada AuthContext.
//
// O service binding real (Worker separado) não roda em teste — mockamos env.CONTACTS
// como um Fetcher que registra o header e devolve um payload canônico.

// Callers (AuthContext): PAT full SEM private (não propaga), PAT full,private (propaga),
// sessão OAuth do dono (sem keyId → propaga), PAT read (não propaga), PAT read,private (propaga).
const NO_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'k_nopriv' };
const WITH_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full,private', keyId: 'k_priv' };
const READ_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'read,private', keyId: 'k_readpriv' };
const OWNER_OAUTH: AuthContext = { email: 'o@x', loggedInAt: 0 }; // sem keyId = dono logado

function collector() {
  const tools: Record<string, any> = {};
  const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
  return { server, tools };
}

// env mock: CONTACTS.fetch captura o header X-Include-Private de cada request e
// devolve um payload vazio válido. Uma instância por chamada pra isolar a captura.
function mockEnv() {
  const seen: Array<{ path: string; includePrivate: string | null }> = [];
  const env: any = {
    CONTACTS_PROXY_TOKEN: 'proxy-tok',
    CONTACTS: {
      fetch: async (req: Request) => {
        seen.push({ path: new URL(req.url).pathname, includePrivate: req.headers.get('x-include-private') });
        return new Response(JSON.stringify({ ok: true, count: 0, results: [], match: null }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
  return { env, seen };
}

async function runAll(auth: AuthContext) {
  const { env, seen } = mockEnv();
  const { tools } = collector();
  registerContactsTools({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, env, auth);
  await tools.list_contacts({});
  await tools.search_contacts({ query: 'x' });
  await tools.get_contact({ id: 'abc' });
  await tools.get_contact_by_phone({ phone: '10009998888' });
  return seen;
}

describe('contacts tools — propagação do escopo private via X-Include-Private (spec 61)', () => {
  it('PAT sem escopo private: NENHUMA das 4 tools envia o header', async () => {
    const seen = await runAll(NO_PRIV);
    expect(seen.length).toBe(4);
    expect(seen.every((s) => s.includePrivate === null)).toBe(true);
  });

  it('PAT full,private: TODAS as 4 tools enviam X-Include-Private:1', async () => {
    const seen = await runAll(WITH_PRIV);
    expect(seen.length).toBe(4);
    expect(seen.every((s) => s.includePrivate === '1')).toBe(true);
  });

  it('PAT read,private: envia o header (escopo private vale mesmo com read)', async () => {
    const seen = await runAll(READ_PRIV);
    expect(seen.every((s) => s.includePrivate === '1')).toBe(true);
  });

  it('sessão OAuth do dono (sem keyId): envia o header (dono vê tudo)', async () => {
    const seen = await runAll(OWNER_OAUTH);
    expect(seen.every((s) => s.includePrivate === '1')).toBe(true);
  });

  it('cobre as 4 superfícies (list/search/get/phone)', async () => {
    const seen = await runAll(NO_PRIV);
    const paths = seen.map((s) => s.path);
    expect(paths).toContain('/list_entities');
    expect(paths).toContain('/recall_entity');
    expect(paths).toContain('/entities/abc');
    expect(paths).toContain('/get_contact_by_phone');
  });
});
