import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// Upsert via SELF.fetch (integração D1). Pega direto os bugs da spec 10-backend/19.

const OWNER = 'test-owner-token';
const authHeaders = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' };

function post(path: string, body: unknown) {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}
function get(path: string) {
  return SELF.fetch(`https://x${path}`, { headers: { authorization: `Bearer ${OWNER}` } });
}

// telefones únicos por teste pra não colidir com o UNIQUE(phone) entre casos
let phoneSeq = 0;
const nextPhone = () => `5511${String(900000000 + phoneSeq++).padStart(9, '0')}`;

describe('handleSaveEntity — validações', () => {
  it('save_person sem name => 400', async () => {
    const res = await post('/save_person', { phone: nextPhone() });
    expect(res.status).toBe(400);
  });

  it('kind inválido em /save_entity => 400', async () => {
    const res = await post('/save_entity', { name: 'X', kind: 'banana' });
    expect(res.status).toBe(400);
  });

  it('category "banana" => 400 com lista allowed', async () => {
    const res = await post('/save_person', { name: 'Cat Test', category: 'banana' });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toContain('invalid category');
    expect(Array.isArray(j.detail?.allowed)).toBe(true);
    expect(j.detail.allowed).toContain('cliente');
  });

  it('category válida do canon (11) => aceita', async () => {
    const res = await post('/save_person', { name: 'Cat OK', category: 'cliente' });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
  });
});

describe('handleSaveEntity — idempotência', () => {
  it('person novo => created; mesmo phone => updated + mesmo id', async () => {
    const phone = nextPhone();
    const r1: any = await (await post('/save_person', { name: 'Ana', phone })).json();
    expect(r1.action).toBe('created');
    const r2: any = await (await post('/save_person', { name: 'Ana Silva', phone })).json();
    expect(r2.action).toBe('updated');
    expect(r2.id).toBe(r1.id);
  });

  it('company idempotente por nome (case-insensitive)', async () => {
    const name = `ACME ${Date.now()}`;
    const r1: any = await (await post('/save_company', { name })).json();
    expect(r1.action).toBe('created');
    const r2: any = await (await post('/save_company', { name: name.toUpperCase() })).json();
    expect(r2.action).toBe('updated');
    expect(r2.id).toBe(r1.id);
  });

  it('COALESCE não sobrescreve campo preenchido com null', async () => {
    const phone = nextPhone();
    const r1: any = await (await post('/save_person', { name: 'Beto', phone, email: 'beto@ex.com' })).json();
    // update sem email => email original permanece
    await post('/save_person', { name: 'Beto', phone });
    const detail: any = await (await get(`/entities/${r1.id}`)).json();
    expect(detail.entity.email).toBe('beto@ex.com');
  });
});

describe('handleSaveEntity — fixes da spec 10-backend/19 (ex-sentinelas)', () => {
  // FIX: no update, `source` agora é bindado como `body.source?.trim() || null`, então
  // COALESCE(?, source) PRESERVA o source original quando o save omite source.
  // (Antes: `body.source || "manual"` sobrescrevia com "manual".)
  it('source preservado quando update omite source', async () => {
    const phone = nextPhone();
    const r1: any = await (await post('/save_person', { name: 'Cida', phone, source: 'google_import' })).json();
    await post('/save_person', { name: 'Cida', phone }); // sem source
    const detail: any = await (await get(`/entities/${r1.id}`)).json();
    expect(detail.entity.source).toBe('google_import');
  });

  // FIX: category "" agora normaliza p/ null ANTES da validação — não fura mais o
  // canon nem grava '' no banco. Uma categoria vazia = "não mexe" (preserva a real).
  it('category vazia ("") não é gravada — vira null (preserva a existente)', async () => {
    const phone = nextPhone();
    // cria com categoria real
    const r1: any = await (await post('/save_person', { name: 'Empty Cat', phone, category: 'cliente' })).json();
    // update com category:"" NÃO deve apagar a categoria real
    const res = await post('/save_person', { name: 'Empty Cat', phone, category: '' });
    expect(res.status).toBe(200);
    const detail: any = await (await get(`/entities/${r1.id}`)).json();
    expect(detail.entity.category).toBe('cliente');
  });
});
