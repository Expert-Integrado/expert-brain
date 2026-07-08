import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';

// Painel "Grupos do WhatsApp" em /app/config#whatsapp-grupos (expert-contacts
// specs/whatsapp-groups-sync.md). Mesmo padrão do google-config-panel: o service
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

describe('painel Grupos do WhatsApp na config', () => {
  it('a aba Conexões carrega a seção #whatsapp-grupos com status e área de grupos', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="whatsapp-grupos"');
    expect(html).toContain('id="wa-status"');
    expect(html).toContain('id="wa-groups-section"');
    expect(html).toContain('id="wa-save-groups"');
    // microcopy que fixa o contrato: allowlist + sem criação de contato novo
    expect(html).toContain('grupos que você marcar');
    expect(html).toContain('não cria contato novo');
  });

  it('bundle da config carrega o wiring do painel', async () => {
    const res = await SELF.fetch('https://x.test/app/config/bundle.js');
    const js = await res.text();
    expect(js).toContain('/app/config/whatsapp/status');
    expect(js).toContain('whatsapp-grupos');
  });
});

describe('proxies /app/config/whatsapp/* — gate de sessão + degradação graciosa', () => {
  it('sem sessão → 302 (GET) / bloqueado (POST), nunca tenta o binding', async () => {
    const g = await SELF.fetch('https://x.test/app/config/whatsapp/status', { redirect: 'manual' });
    expect(g.status).toBe(302);
    const p = await SELF.fetch('https://x.test/app/config/whatsapp/allowlist', { method: 'POST', redirect: 'manual' });
    expect([302, 401]).toContain(p.status);
  });

  it('com sessão mas sem binding CONTACTS configurado → 503 nos dois', async () => {
    const ck = await cookie();
    const g = await SELF.fetch('https://x.test/app/config/whatsapp/status', { headers: { cookie: ck } });
    expect(g.status).toBe(503);
    const p = await SELF.fetch('https://x.test/app/config/whatsapp/allowlist', {
      method: 'POST', headers: { cookie: ck }, body: '{}',
    });
    expect(p.status).toBe(503);
  });
});
