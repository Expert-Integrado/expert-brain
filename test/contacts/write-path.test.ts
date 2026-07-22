import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// Cobre os fixes da spec 10-backend/19 que ainda não tinham teste dedicado:
// dedupe por variante de telefone, conexão simétrica invertida → 409,
// /event kind/source inválido → 400, attach_media dedup no D1, parseIntSafe (NaN),
// GET /canon.

const OWNER = 'test-owner-token';
const authHeaders = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' };

const post = (path: string, body: unknown) =>
  SELF.fetch(`https://x${path}`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
const get = (path: string) =>
  SELF.fetch(`https://x${path}`, { headers: { authorization: `Bearer ${OWNER}` } });

describe('dedupe por variante de telefone (spec 19 §2)', () => {
  it('phone sem 9º dígito resolve pra entidade salva com 9º — mesmo id, updated', async () => {
    // salva com 9º dígito + source/category
    const r1: any = await (await post('/save_person', {
      name: 'Nono Digito', phone: '5511987654321', source: 'pipedrive', category: 'network',
    })).json();
    expect(r1.action).toBe('created');
    // salva de novo com a variante SEM o 9 → deve casar a mesma entidade
    const r2: any = await (await post('/save_person', {
      name: 'Nono Digito', phone: '551187654321',
    })).json();
    expect(r2.action).toBe('updated');
    expect(r2.id).toBe(r1.id);
    // proveniência intacta: source e category preservados no update sem eles
    const detail: any = await (await get(`/entities/${r1.id}`)).json();
    expect(detail.entity.source).toBe('pipedrive');
    expect(detail.entity.category).toBe('network');
  });

  it('match EXATO ganha quando as duas variantes existem', async () => {
    // cria as duas variantes como entidades distintas via INSERT direto
    const idSem = crypto.randomUUID();
    const idCom = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, source) VALUES (?, 'person', 'Sem9', '551133334444', 'seed')`
    ).bind(idSem).run();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, source) VALUES (?, 'person', 'Com9', '5511933334444', 'seed')`
    ).bind(idCom).run();
    // save com o número exato COM 9 deve casar idCom (match exato), não idSem
    const r: any = await (await post('/save_person', { name: 'Com9 upd', phone: '5511933334444' })).json();
    expect(r.action).toBe('updated');
    expect(r.id).toBe(idCom);
  });
});

describe('conexão simétrica invertida → 409 (spec 19 §5)', () => {
  it('connect(B,A,friend) colide com connect(A,B,friend) existente', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    for (const [id, n] of [[a, 'SymA'], [b, 'SymB']] as const) {
      await env.DB.prepare(`INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', ?, 'seed')`).bind(id, n).run();
    }
    const why = 'amigos de longa data desde a faculdade em 2005';
    const r1 = await post('/connect', { a_id: a, b_id: b, type: 'friend', strength: 0.6, why });
    expect(r1.status).toBe(200);
    // invertido — mesmo tipo simétrico → deve dar 409
    const r2 = await post('/connect', { a_id: b, b_id: a, type: 'friend', strength: 0.6, why });
    expect(r2.status).toBe(409);
  });

  it('tipo direcional permite os dois sentidos', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    for (const [id, n] of [[a, 'DirA'], [b, 'DirB']] as const) {
      await env.DB.prepare(`INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', ?, 'seed')`).bind(id, n).run();
    }
    const why = 'um apresentou o outro numa rodada de investimento em 2022';
    const r1 = await post('/connect', { a_id: a, b_id: b, type: 'introduced_by', strength: 0.5, why });
    expect(r1.status).toBe(200);
    const r2 = await post('/connect', { a_id: b, b_id: a, type: 'introduced_by', strength: 0.5, why });
    expect(r2.status).toBe(200); // sentido oposto de tipo direcional é uma aresta distinta
  });
});

describe('/event validação de kind e source (spec 19 §6)', () => {
  let eid = '';
  it('setup entidade', async () => {
    eid = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', 'Ev Ent', 'seed')`).bind(eid).run();
    expect(eid).toBeTruthy();
  });

  it('kind inválido → 400 com allowed', async () => {
    const res = await post('/event', { entity_id: eid, kind: 'talkd' });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toContain('invalid kind');
    expect(j.detail.allowed).toContain('talked');
  });

  it('source inválido → 400', async () => {
    const res = await post('/event', { entity_id: eid, kind: 'talked', source: 'zapzap' });
    expect(res.status).toBe(400);
  });

  it('kind válido → 200 e atualiza last_contacted', async () => {
    const res = await post('/event', { entity_id: eid, kind: 'talked' });
    expect(res.status).toBe(200);
    const detail: any = await (await get(`/entities/${eid}`)).json();
    expect(detail.entity.last_contacted).toBeTruthy();
  });
});

describe('attach_media dedup no D1 (spec 19 §7)', () => {
  // payload base64 pequeno determinístico (1x1 png-ish bytes bastam — não precisa ser imagem válida)
  const b64 = btoa('hello-media-dedup-fixture');

  it('mesmo conteúdo na mesma entidade → deduped:true, 1 linha só', async () => {
    const eid = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', 'Media Ent', 'seed')`).bind(eid).run();

    const r1: any = await (await post('/attach_media', { entity_id: eid, base64: b64, mime_type: 'image/png' })).json();
    expect(r1.ok).toBe(true);
    const r2: any = await (await post('/attach_media', { entity_id: eid, base64: b64, mime_type: 'image/png' })).json();
    expect(r2.deduped).toBe(true);
    expect(r2.id).toBe(r1.id); // mesma linha original

    const cnt = await env.DB.prepare('SELECT COUNT(*) c FROM media WHERE entity_id = ?').bind(eid).first<{ c: number }>();
    expect(cnt?.c).toBe(1);
  });

  it('mesmo conteúdo em OUTRA entidade → cria linha nova', async () => {
    const e1 = crypto.randomUUID();
    const e2 = crypto.randomUUID();
    for (const id of [e1, e2]) {
      await env.DB.prepare(`INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', 'M', 'seed')`).bind(id).run();
    }
    const payload = btoa(`shared-content-${crypto.randomUUID()}`);
    await post('/attach_media', { entity_id: e1, base64: payload, mime_type: 'image/png' });
    const r2: any = await (await post('/attach_media', { entity_id: e2, base64: payload, mime_type: 'image/png' })).json();
    expect(r2.ok).toBe(true);
    const c1 = await env.DB.prepare('SELECT COUNT(*) c FROM media WHERE entity_id = ?').bind(e1).first<{ c: number }>();
    const c2 = await env.DB.prepare('SELECT COUNT(*) c FROM media WHERE entity_id = ?').bind(e2).first<{ c: number }>();
    expect(c1?.c).toBe(1);
    expect(c2?.c).toBe(1);
  });
});

describe('parseIntSafe — NaN nunca vira 500 (spec 19 §8)', () => {
  it('list_entities?limit=abc → 200 com default', async () => {
    const res = await get('/list_entities?limit=abc&offset=xyz');
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
  });

  it('recall_entity?limit=abc → 200 (modo sql_like sem VECTORIZE)', async () => {
    const res = await get('/recall_entity?q=teste&limit=abc');
    expect(res.status).toBe(200);
  });

  it('setup/reembed?offset=abc → 503 (VECTORIZE ausente) e nunca 500 por NaN', async () => {
    // sem VECTORIZE binding a rota devolve 503 ANTES do parse — garante que não é 500
    const res = await post('/setup/reembed?offset=abc&limit=abc', {});
    expect(res.status).toBe(503);
  });
});

describe('GET /canon (spec 19 §1)', () => {
  it('retorna as 6 listas de enums', async () => {
    const j: any = await (await get('/canon')).json();
    expect(j.ok).toBe(true);
    expect(j.conn_types).toContain('friend');
    expect(j.symmetric_conn_types).toContain('friend');
    expect(j.symmetric_conn_types).not.toContain('introduced_by');
    expect(j.entity_kinds).toContain('person');
    expect(j.contact_categories).toContain('cliente');
    expect(j.event_kinds).toContain('talked');
    expect(j.event_sources).toContain('whatsapp');
  });

  it('acessível com CONTACTS_PROXY_TOKEN (read-only GET)', async () => {
    const res = await SELF.fetch('https://x/canon', { headers: { authorization: 'Bearer test-proxy-token' } });
    expect(res.status).toBe(200);
  });
});
