import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

// requireAuth (src/index.ts): OWNER_TOKEN read+write, CONTACTS_PROXY_TOKEN
// read-only (POST => 401), sem token => 401, /health público.

const OWNER = 'test-owner-token';
const PROXY = 'test-proxy-token';

const req = (path: string, opts: { method?: string; token?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return SELF.fetch(`https://x${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.method === 'POST' ? JSON.stringify({ name: 'Auth Probe' }) : undefined,
  });
};

describe('auth — sem token', () => {
  it('GET /list_entities sem token => 401', async () => {
    expect((await req('/list_entities')).status).toBe(401);
  });
  it('POST /save_person sem token => 401', async () => {
    expect((await req('/save_person', { method: 'POST' })).status).toBe(401);
  });
});

describe('auth — OWNER_TOKEN (read + write)', () => {
  it('GET /list_entities => 200', async () => {
    expect((await req('/list_entities', { token: OWNER })).status).toBe(200);
  });
  it('POST /save_person => 200', async () => {
    expect((await req('/save_person', { method: 'POST', token: OWNER })).status).toBe(200);
  });
});

describe('auth — CONTACTS_PROXY_TOKEN (read-only)', () => {
  it('GET /list_entities => 200', async () => {
    expect((await req('/list_entities', { token: PROXY })).status).toBe(200);
  });
  it('POST /save_person => 401 (write bloqueado)', async () => {
    expect((await req('/save_person', { method: 'POST', token: PROXY })).status).toBe(401);
  });
});

describe('auth — token inválido e rota pública', () => {
  it('token inválido => 401', async () => {
    expect((await req('/list_entities', { token: 'nope-invalid' })).status).toBe(401);
  });
  it('GET /health => 200 SEM token (única rota pública)', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.service).toBe('expert-contacts');
  });
});

// Spec 10-backend/24: escopo do proxy token vira allowlist explícita
// (src/auth/tokens.ts) + comparação constante em todo bearer.
describe('auth — allowlist do CONTACTS_PROXY_TOKEN (spec 10-backend/24)', () => {
  it('paths permitidos respondem sem 401', async () => {
    for (const p of ['/recall_entity?q=x', '/get_contact_by_phone?phone=5511999999999', '/list_entities?limit=1', '/canon']) {
      const res = await req(p, { token: PROXY });
      expect(res.status, p).not.toBe(401);
    }
  });
  it('detalhe de entidade (/entities/:id) passa pela allowlist (404 para id inexistente, nunca 401)', async () => {
    const res = await req('/entities/00000000-0000-0000-0000-000000000000', { token: PROXY });
    expect(res.status).not.toBe(401);
  });
  it('/media/:hash passa pela allowlist (avatar do console do Brain)', async () => {
    const res = await req(`/media/${'a'.repeat(64)}`, { token: PROXY });
    expect(res.status).not.toBe(401);
  });
  it('paths FORA da allowlist => 401 com o proxy token', async () => {
    for (const p of ['/list_people', '/list_companies', '/graph/data', '/entities/00000000-0000-0000-0000-000000000000/media']) {
      const res = await req(p, { token: PROXY });
      expect(res.status, p).toBe(401);
    }
  });
  it('OWNER_TOKEN continua passando nos paths bloqueados pro proxy', async () => {
    for (const p of ['/list_people', '/graph/data']) {
      const res = await req(p, { token: OWNER });
      expect(res.status, p).not.toBe(401);
    }
  });
});

describe('health — bloco maint (spec 40-ops/43)', () => {
  it('GET /health expõe maint com defaults', async () => {
    const res = await req('/health');
    const j: any = await res.json();
    expect(j.maint).toBeDefined();
    expect(typeof j.maint.consecutive_failures).toBe('number');
    expect('last_run' in j.maint).toBe(true);
    expect(typeof j.maint.cursor_pending).toBe('boolean');
  });
});
