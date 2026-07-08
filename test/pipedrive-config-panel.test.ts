import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';

// Painel "Pipedrive (CRM)" em /app/config#pipedrive-crm — integração OPCIONAL do
// worker de contatos. Mesmo padrão dos painéis WhatsApp/Instagram: gate de sessão
// e degradação graciosa (503) sem o service binding CONTACTS.

const E = env as any;

beforeAll(async () => {
  await runMigrations(E);
});

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('painel Pipedrive na config', () => {
  it('a aba Conexões carrega a seção #pipedrive-crm com status e botão de sync', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="pipedrive-crm"');
    expect(html).toContain('id="pd-status"');
    expect(html).toContain('id="pd-sync"');
    // microcopy que fixa o contrato: opcional, conexão explícita, mão única,
    // só preenche vazios de quem já existe
    expect(html).toContain('só funciona se você conectar explicitamente');
    expect(html).toContain('só preenche campos vazios');
    expect(html).toContain('nunca cria contato');
  });

  it('bundle da config carrega o wiring do painel', async () => {
    const res = await SELF.fetch('https://x.test/app/config/bundle.js');
    const js = await res.text();
    expect(js).toContain('/app/config/pipedrive/status');
    expect(js).toContain('pipedrive-crm');
  });
});

describe('proxies /app/config/pipedrive/* — gate de sessão + degradação graciosa', () => {
  it('sem sessão → 302 (GET) / bloqueado (POST), nunca tenta o binding', async () => {
    const g = await SELF.fetch('https://x.test/app/config/pipedrive/status', { redirect: 'manual' });
    expect(g.status).toBe(302);
    const p = await SELF.fetch('https://x.test/app/config/pipedrive/sync', { method: 'POST', redirect: 'manual' });
    expect([302, 401]).toContain(p.status);
  });

  it('com sessão mas sem binding CONTACTS configurado → 503 nos dois', async () => {
    const ck = await cookie();
    const g = await SELF.fetch('https://x.test/app/config/pipedrive/status', { headers: { cookie: ck } });
    expect(g.status).toBe(503);
    const p = await SELF.fetch('https://x.test/app/config/pipedrive/sync', {
      method: 'POST', headers: { cookie: ck },
    });
    expect(p.status).toBe(503);
  });
});
