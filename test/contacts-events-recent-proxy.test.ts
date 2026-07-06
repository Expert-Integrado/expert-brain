import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { signSession } from '../src/web/session.js';

// Spec 50-console-v2/65 §1 — proxy do Brain (sessão) pro feed global de interações
// do contacts. Mesmo padrão de test/contacts-entity-event-proxy.test.ts: o service
// binding CONTACTS (Worker separado) não é simulado aqui — cobre-se o gate de
// sessão do Brain e a degradação graciosa (503) quando CONTACTS/CONTACTS_PROXY_TOKEN
// não estão configurados (caso real deste ambiente de teste).

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('GET /app/contacts/events/recent — proxy read-only (spec 65 §1)', () => {
  it('sem sessão → 302 (redirect pro login)', async () => {
    const res = await SELF.fetch('https://x/app/contacts/events/recent', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('com sessão mas CONTACTS/CONTACTS_PROXY_TOKEN não configurados → 503 (degradação graciosa)', async () => {
    const res = await SELF.fetch('https://x/app/contacts/events/recent?limit=5', {
      headers: { cookie: await cookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(503);
  });
});
