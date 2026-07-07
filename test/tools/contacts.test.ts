import { describe, it, expect, vi } from 'vitest';
import { registerContactsTools } from '../../src/mcp/tools/contacts.js';

// spec 10-backend/23: as mensagens de erro do proxy de contatos são contrato com o
// agente — 404 (não existe) vs 503 (deploy sem binding) vs 5xx (transiente, retry)
// têm que ser distinguíveis pelo TEXTO. E `category` é enum, não string livre.

const AUTH = { email: 'test@example.com', loggedInAt: 0 } as any;

function reg(env: any) {
  const tools: any = {};
  const schemas: any = {};
  registerContactsTools(
    { registerTool: (n: string, meta: any, h: any) => { tools[n] = h; schemas[n] = meta.inputSchema; } } as any,
    env,
    AUTH
  );
  return { tools, schemas };
}

function fakeContacts(status: number, body: unknown) {
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })),
  };
}

describe('contacts tools error contract (spec 23)', () => {
  it('binding ausente => "not configured in this deploy", nunca "not found"', async () => {
    const { tools } = reg({});
    const r = await tools.get_contact({ id: 'abc' });
    const text = r.content[0].text as string;
    expect(r.isError).toBe(true);
    expect(text).toContain('not configured in this deploy');
    expect(text).toContain('deployment issue');
    expect(text).not.toContain('not found');
  });

  it('404 do worker => "not found" + instrucao de nao re-tentar', async () => {
    const env = { CONTACTS: fakeContacts(404, { error: 'no such entity' }), CONTACTS_PROXY_TOKEN: 'tok' };
    const { tools } = reg(env);
    const r = await tools.get_contact({ id: 'ghost' });
    const text = r.content[0].text as string;
    expect(r.isError).toBe(true);
    expect(text).toContain('not found');
    expect(text).toContain('do not retry');
  });

  it('500 do worker => indisponibilidade temporaria sugerindo retry, nas 4 tools', async () => {
    const env = { CONTACTS: fakeContacts(500, { error: 'boom' }), CONTACTS_PROXY_TOKEN: 'tok' };
    const { tools } = reg(env);
    for (const call of [
      () => tools.list_contacts({}),
      () => tools.search_contacts({ query: 'x' }),
      () => tools.get_contact({ id: 'abc' }),
      () => tools.get_contact_by_phone({ phone: '5511999999999' }),
    ]) {
      const r = await call();
      const text = r.content[0].text as string;
      expect(r.isError).toBe(true);
      expect(text).toContain('temporarily unavailable');
      expect(text).toContain('retry');
    }
  });

  it('503 REAL do worker (nao sintetico) tambem diagnostica deploy, nao dado', async () => {
    const env = { CONTACTS: fakeContacts(503, { error: 'service down' }), CONTACTS_PROXY_TOKEN: 'tok' };
    const { tools } = reg(env);
    const r = await tools.list_contacts({});
    expect(r.content[0].text).toContain('not configured in this deploy');
  });

  it('category e z.enum: typo rejeitado com os valores aceitos, valor canonico passa', () => {
    const { schemas } = reg({});
    for (const tool of ['list_contacts', 'search_contacts']) {
      const cat = schemas[tool].category;
      expect(cat.safeParse('clientes').success).toBe(false); // typo
      expect(cat.safeParse('cliente').success).toBe(true);
      expect(cat.safeParse(undefined).success).toBe(true); // continua opcional
      const err = cat.safeParse('clientes').error;
      // o erro do zod enumera as opcoes — o agente se autocorrige
      expect(JSON.stringify(err?.issues)).toContain('cliente');
    }
  });

  it('category valida e propagada no querystring pro worker', async () => {
    const contacts = fakeContacts(200, { count: 0, results: [] });
    const env = { CONTACTS: contacts, CONTACTS_PROXY_TOKEN: 'tok' };
    const { tools } = reg(env);
    await tools.list_contacts({ category: 'cliente' });
    const req = (contacts.fetch.mock.calls[0] as unknown[])[0] as Request;
    expect(new URL(req.url).searchParams.get('category')).toBe('cliente');
  });
});
