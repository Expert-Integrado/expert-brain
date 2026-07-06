import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { signSession } from '../src/web/session.js';

// Spec 50-console-v2/57 §2/§3 — proxy do Brain pra timeline paginada (GET) e
// registro manual (POST) de interação de contato. O service binding CONTACTS
// (Worker separado) não é exercitado aqui — mesmo padrão do resto do repo, que
// não simula esse binding em teste (handleContactsData/Meta/Entity também não
// têm cobertura de integração). Cobrimos o que É testável sem o binding vivo:
// o gate de sessão do Brain e a degradação graciosa (503) quando
// CONTACTS/CONTACTS_WRITE_TOKEN não estão configurados (caso real deste ambiente
// de teste — vitest.config.ts não os declara).

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('GET /app/contacts/entity/events — proxy read-only', () => {
  it('sem sessão → 302 (redirect pro login)', async () => {
    const res = await SELF.fetch('https://x/app/contacts/entity/events?id=abc', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('com sessão mas CONTACTS/CONTACTS_PROXY_TOKEN não configurados → 503 (degradação graciosa)', async () => {
    const ck = await cookie();
    const res = await SELF.fetch('https://x/app/contacts/entity/events?id=abc', {
      headers: { cookie: ck },
      redirect: 'manual',
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /app/contacts/entity/event — proxy de ESCRITA escopado', () => {
  it('sem sessão → 302 (redirect pro login), nunca tenta o proxy', async () => {
    const res = await SELF.fetch('https://x/app/contacts/entity/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity_id: 'abc', kind: 'talked' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('com sessão mas CONTACTS/CONTACTS_WRITE_TOKEN não configurados → 503 (degradação graciosa, NUNCA vaza o CONTACTS_PROXY_TOKEN read-only pra escrita)', async () => {
    const ck = await cookie();
    const res = await SELF.fetch('https://x/app/contacts/entity/event', {
      method: 'POST',
      headers: { cookie: ck, 'content-type': 'application/json' },
      body: JSON.stringify({ entity_id: 'abc', kind: 'talked' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(503);
    const j: any = await res.json();
    expect(j.ok).toBe(false);
  });
});
