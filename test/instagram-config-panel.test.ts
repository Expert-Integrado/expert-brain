import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';

// Painel "Conversas do Instagram" em /app/config#instagram-contatos (expert-contacts
// specs/instagram-contacts-sync.md). Mesmo padrão do whatsapp-config-panel: o service
// binding CONTACTS não existe neste ambiente de teste, então cobrimos o gate de
// sessão e a degradação graciosa (503) dos proxies.

const E = env as any;

beforeAll(async () => {
  await runMigrations(E);
});

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('painel Conversas do Instagram na config', () => {
  it('a aba Conexões carrega a seção #instagram-contatos com status e área de conversas', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="instagram-contatos"');
    expect(html).toContain('id="ig-status"');
    expect(html).toContain('id="ig-contacts-section"');
    expect(html).toContain('id="ig-save-contacts"');
    // microcopy que fixa o contrato: dependência obrigatória do agente, allowlist
    // pré-marcada por padrão, criação deliberada por conversa marcada
    expect(html).toContain('Requer o <strong>Instagram Agent conectado</strong>');
    expect(html).toContain('conversas que você marcar');
    expect(html).toContain('por padrão todas vêm marcadas');
    expect(html).toContain('cria o contato');
    expect(html).toContain('nunca são sobrescritos');
    expect(html).toContain('id="ig-select-all"');
    expect(html).toContain('id="ig-clear-all"');
  });

  it('bundle da config carrega o wiring do painel', async () => {
    const res = await SELF.fetch('https://x.test/app/config/bundle.js');
    const js = await res.text();
    expect(js).toContain('/app/config/instagram/status');
    expect(js).toContain('instagram-contatos');
  });
});

describe('proxies /app/config/instagram/* — gate de sessão + degradação graciosa', () => {
  it('sem sessão → 302 (GET) / bloqueado (POST), nunca tenta o binding', async () => {
    const g = await SELF.fetch('https://x.test/app/config/instagram/status', { redirect: 'manual' });
    expect(g.status).toBe(302);
    const p = await SELF.fetch('https://x.test/app/config/instagram/allowlist', { method: 'POST', redirect: 'manual' });
    expect([302, 401]).toContain(p.status);
  });

  it('com sessão mas sem binding CONTACTS configurado → 503 nos dois', async () => {
    const ck = await cookie();
    const g = await SELF.fetch('https://x.test/app/config/instagram/status', { headers: { cookie: ck } });
    expect(g.status).toBe(503);
    const p = await SELF.fetch('https://x.test/app/config/instagram/allowlist', {
      method: 'POST', headers: { cookie: ck }, body: '{}',
    });
    expect(p.status).toBe(503);
  });
});
