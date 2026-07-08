import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';

// Painel "Google Contatos" em /app/config#google-contatos (expert-contacts
// specs/google-contacts-sync.md). Mesmo padrão do contacts-entity-event-proxy:
// o service binding CONTACTS não existe neste ambiente de teste, então cobrimos
// o gate de sessão e a degradação graciosa (503) dos proxies.

const E = env as any;

beforeAll(async () => {
  await runMigrations(E);
});

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('painel Google Contatos na config', () => {
  it('a aba Conexões carrega a seção #google-contatos com botões e área de etiquetas', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="google-contatos"');
    expect(html).toContain('id="gc-connect"');
    expect(html).toContain('id="gc-sync"');
    expect(html).toContain('id="gc-labels-section"');
    // microcopy que fixa o contrato: mão única, Google nunca alterado
    expect(html).toContain('o Google nunca é alterado');
  });

  it('bundle da config carrega o wiring do painel', async () => {
    const res = await SELF.fetch('https://x.test/app/config/bundle.js');
    const js = await res.text();
    expect(js).toContain('/app/config/google/status');
    expect(js).toContain('google-contatos');
  });
});

describe('proxies /app/config/google/* — gate de sessão + degradação graciosa', () => {
  const gets = ['/app/config/google/status', '/app/config/google/labels'];
  const posts = ['/app/config/google/connect', '/app/config/google/config', '/app/config/google/sync', '/app/config/google/disconnect'];

  it('sem sessão → 302 (GET) / bloqueado (POST), nunca tenta o binding', async () => {
    for (const p of gets) {
      const res = await SELF.fetch(`https://x.test${p}`, { redirect: 'manual' });
      expect(res.status, p).toBe(302);
    }
    for (const p of posts) {
      const res = await SELF.fetch(`https://x.test${p}`, { method: 'POST', redirect: 'manual' });
      expect([302, 401], p).toContain(res.status);
    }
  });

  it('com sessão mas sem binding CONTACTS configurado → 503 em todos', async () => {
    const ck = await cookie();
    for (const p of gets) {
      const res = await SELF.fetch(`https://x.test${p}`, { headers: { cookie: ck } });
      expect(res.status, p).toBe(503);
    }
    for (const p of posts) {
      const res = await SELF.fetch(`https://x.test${p}`, { method: 'POST', headers: { cookie: ck }, body: '{}' });
      expect(res.status, p).toBe(503);
    }
  });
});
