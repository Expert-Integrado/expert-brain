import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// handleRecall (modo sql_like, sem VECTORIZE), list_entities e get_contact_by_phone.

const OWNER = 'test-owner-token';
const get = (path: string) =>
  SELF.fetch(`https://x${path}`, { headers: { authorization: `Bearer ${OWNER}` } });

// Seed determinístico: prefixo único pra isolar do resto da suíte.
const TAG = 'zqx'; // aparece só nos registros deste arquivo (via role)
const PHONE_EXACT = '5511977777001';

beforeAll(async () => {
  const rows: Array<{ id: string; kind: string; name: string; phone?: string; category?: string; role?: string }> = [
    { id: crypto.randomUUID(), kind: 'person', name: `Fulano ${TAG}`, phone: PHONE_EXACT, category: 'cliente', role: `dev ${TAG}` },
    { id: crypto.randomUUID(), kind: 'company', name: `Empresa ${TAG}`, category: 'parceiro', role: `setor ${TAG}` },
    { id: crypto.randomUUID(), kind: 'person', name: `Beltrano ${TAG}`, category: 'lead', role: `sdr ${TAG}` },
    // registro CRU: name sem letra (só dígitos) — escondido por padrão
    { id: crypto.randomUUID(), kind: 'person', name: `5511900000${TAG.length}`, role: `raw ${TAG}` },
  ];
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, category, role, source)
       VALUES (?, ?, ?, ?, ?, ?, 'test')`
    ).bind(r.id, r.kind, r.name, r.phone ?? null, r.category ?? null, r.role ?? null).run();
  }
});

describe('handleRecall — modo sql_like', () => {
  it('sem q => 400', async () => {
    const res = await get('/recall_entity');
    expect(res.status).toBe(400);
  });

  it('reporta mode sql_like quando VECTORIZE ausente', async () => {
    const j: any = await (await get(`/recall_entity?q=${TAG}`)).json();
    expect(j.mode).toBe('sql_like');
    expect(j.ok).toBe(true);
  });

  it('filtro kind=company restringe', async () => {
    const j: any = await (await get(`/recall_entity?q=${TAG}&kind=company`)).json();
    expect(j.count).toBeGreaterThanOrEqual(1);
    for (const r of j.results) expect(r.kind).toBe('company');
  });

  it('filtro category=lead restringe', async () => {
    const j: any = await (await get(`/recall_entity?q=${TAG}&category=lead`)).json();
    expect(j.count).toBeGreaterThanOrEqual(1);
    for (const r of j.results) expect(r.category).toBe('lead');
  });

  it('include_raw default (false) esconde nome-sem-letra', async () => {
    const hidden: any = await (await get(`/recall_entity?q=${TAG}`)).json();
    const names: string[] = hidden.results.map((r: any) => r.name);
    expect(names.some((n) => /^\d+$/.test(n))).toBe(false);

    const shown: any = await (await get(`/recall_entity?q=${TAG}&include_raw=true`)).json();
    expect(shown.count).toBeGreaterThan(hidden.count);
  });
});

describe('handleListEntities — filtros e paginação', () => {
  it('filtro kind', async () => {
    const j: any = await (await get('/list_entities?kind=company&limit=1000')).json();
    for (const r of j.results) expect(r.kind).toBe('company');
  });

  it('filtro category', async () => {
    const j: any = await (await get('/list_entities?category=cliente&limit=1000')).json();
    for (const r of j.results) expect(r.category).toBe('cliente');
  });

  it('has_phone só devolve quem tem phone', async () => {
    const j: any = await (await get('/list_entities?has_phone=true&limit=1000')).json();
    for (const r of j.results) expect(r.phone).toBeTruthy();
  });

  it('include_raw default esconde nomes sem letra; true mostra', async () => {
    const hidden: any = await (await get('/list_entities?limit=1000')).json();
    const shown: any = await (await get('/list_entities?include_raw=true&limit=1000')).json();
    expect(shown.count).toBeGreaterThanOrEqual(hidden.count);
    const rawShown = shown.results.some((r: any) => /^\d+$/.test(r.name));
    const rawHidden = hidden.results.some((r: any) => /^\d+$/.test(r.name));
    expect(rawHidden).toBe(false);
    expect(rawShown).toBe(true);
  });

  it('paginação limit/offset', async () => {
    const page1: any = await (await get('/list_entities?limit=2&offset=0')).json();
    const page2: any = await (await get('/list_entities?limit=2&offset=2')).json();
    expect(page1.results.length).toBeLessThanOrEqual(2);
    // ids da página 2 não repetem os da página 1
    const ids1 = new Set(page1.results.map((r: any) => r.id));
    for (const r of page2.results) expect(ids1.has(r.id)).toBe(false);
  });
});

describe('get_contact_by_phone — match exato + variantes', () => {
  it('sem phone => 400', async () => {
    const res = await get('/get_contact_by_phone');
    expect(res.status).toBe(400);
  });

  it('match exato pelo número salvo', async () => {
    const j: any = await (await get(`/get_contact_by_phone?phone=${PHONE_EXACT}`)).json();
    expect(j.match).not.toBeNull();
    expect(j.match.phone).toBe(PHONE_EXACT);
  });

  it('acha via variante (sem 9º dígito casa o salvo com 9º)', async () => {
    // salvo: 5511977777001 (13 díg, com 9). Consulta pela versão sem o 9: 551177777001
    const j: any = await (await get('/get_contact_by_phone?phone=551177777001')).json();
    expect(j.variants).toContain(PHONE_EXACT);
    expect(j.match).not.toBeNull();
    expect(j.match.phone).toBe(PHONE_EXACT);
  });
});
