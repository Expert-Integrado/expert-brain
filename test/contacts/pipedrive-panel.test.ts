import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { proxyTokenAllowsPath, writeTokenAllowsPath } from '../../src/contacts/auth/tokens';

// Pipedrive como integração OPCIONAL explícita: rotas do painel do Brain
// (/pipedrive/status via proxy token, /pipedrive/sync via write token). Sem o
// secret PIPEDRIVE_API_KEY a integração está desligada — o sync responde erro
// explicando e o status reporta configured:false.

const E = env as any;

describe('allowlists de token', () => {
  it('proxy lê /pipedrive/status; write dispara /pipedrive/sync; resto fechado', () => {
    expect(proxyTokenAllowsPath('/pipedrive/status')).toBe(true);
    expect(writeTokenAllowsPath('/pipedrive/sync')).toBe(true);
    expect(proxyTokenAllowsPath('/pipedrive/sync')).toBe(false);
    expect(writeTokenAllowsPath('/pipedrive/status')).toBe(false);
    expect(writeTokenAllowsPath('/maintenance/run')).toBe(false); // rota antiga segue OWNER only
  });
});

describe('rotas do painel', () => {
  it('status reporta configured:false sem secret; sync desligado responde erro sem contar falha', async () => {
    const st = await SELF.fetch('https://x.test/pipedrive/status', {
      headers: { authorization: `Bearer ${E.OWNER_TOKEN}` },
    });
    expect(st.status).toBe(200);
    const j = await st.json() as any;
    expect(j.ok).toBe(true);
    expect(j.configured).toBe(false); // ambiente de teste não tem PIPEDRIVE_API_KEY
    expect(j).toHaveProperty('last_run');
    expect(j).toHaveProperty('consecutive_failures');

    const sync = await SELF.fetch('https://x.test/pipedrive/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${E.OWNER_TOKEN}` },
    });
    const sj = await sync.json() as any;
    expect(sj.ok).toBe(false);
    expect(sj.error).toContain('PIPEDRIVE_API_KEY');
  });

  it('sem bearer válido → 401', async () => {
    const r = await SELF.fetch('https://x.test/pipedrive/status');
    expect(r.status).toBe(401);
  });
});
