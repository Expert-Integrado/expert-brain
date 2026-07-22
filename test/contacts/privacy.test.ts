import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';
import { callerSeesPrivate } from '../../src/contacts/web/privacy';
import { observationsTextFor } from '../../src/contacts/embedding';

// Suíte do SELO DE PRIVACIDADE do vault de contatos (spec 50-console-v2/61):
// teste de vazamento POR SUPERFÍCIE. Uma entidade/evento `private = 1` NUNCA pode
// aparecer (nem em contagem) pra um caller que não vê privados (proxy sem header),
// em NENHUM read path GET (grafo, detalhe, timeline, vizinhos, REST search/list/
// phone). O dono (OWNER_TOKEN / sessão / proxy+header) vê tudo.
//
// Fixtures 100% fictícias. Telefones NÃO iniciam em 55 (dado de teste, não real).

const OWNER = 'test-owner-token';
const PROXY = 'test-proxy-token';
const WRITE = 'test-write-token';
const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const WHY = 'vinculo de teste com no minimo vinte caracteres aqui';

// Tokens únicos por termo pra isolar os matches de busca das outras suítes.
const NAME_PRIV = 'Zephyrqx Privada';
const TOKEN_PRIV_NAME = 'zephyrqx';
const TOKEN_PRIV_OBS = 'xylophonium'; // só existe numa OBSERVAÇÃO privada de um contato público
const PRIV_PHONE = '10009998888';

let pubA = '';   // pública, conectada a pubB e a privC, com observação privada
let pubB = '';   // pública, similar a privC
let privC = '';  // PRIVADA

async function cookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

const seedEntity = async (opts: { kind?: string; name: string; priv?: number; phone?: string }): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, source, private, phone) VALUES (?, ?, ?, 'seed', ?, ?)`,
  ).bind(id, opts.kind ?? 'person', opts.name, opts.priv ?? 0, opts.phone ?? null).run();
  return id;
};
const seedConn = async (a: string, b: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, 'friend', 0.6, ?)`,
  ).bind(crypto.randomUUID(), a, b, WHY).run();
};
const seedSimilar = async (from: string, to: string, score: number): Promise<void> => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO similar_edges (from_id, to_id, score) VALUES (?, ?, ?)`,
  ).bind(from, to, score).run();
};
const seedEvent = async (entityId: string, context: string, priv: number): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO events (id, entity_id, kind, context, source, private) VALUES (?, ?, 'note', ?, 'manual', ?)`,
  ).bind(crypto.randomUUID(), entityId, context, priv).run();
};

// Helpers de request
const restGet = (path: string, opts: { token?: string; header?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.header) headers['x-include-private'] = opts.header;
  return SELF.fetch(`https://x${path}`, { headers, redirect: 'manual' });
};
const appGet = (path: string, opts: { token?: string; header?: string; cookie?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.header) headers['x-include-private'] = opts.header;
  if (opts.cookie) headers.cookie = opts.cookie;
  return SELF.fetch(`https://x${path}`, { headers, redirect: 'manual' });
};

beforeAll(async () => {
  pubA = await seedEntity({ name: 'Aurelio Publico' });
  pubB = await seedEntity({ name: 'Bruna Publica' });
  privC = await seedEntity({ name: NAME_PRIV, priv: 1, phone: PRIV_PHONE });
  await seedConn(pubA, pubB);
  await seedConn(pubA, privC);         // conexão explícita c/ ponta privada
  await seedSimilar(pubB, privC, 0.88); // aresta de similaridade c/ ponta privada
  await seedEvent(pubA, `${TOKEN_PRIV_OBS} anotacao confidencial`, 1); // observação PRIVADA em contato PÚBLICO
  await seedEvent(pubA, 'observacao publica normal', 0);               // observação pública
});

describe('migration 0007 — coluna private, defaults intactos', () => {
  it('entidade pública nasce private=0; a marcada nasce private=1', async () => {
    const a = await env.DB.prepare('SELECT private FROM entities WHERE id = ?').bind(pubA).first<{ private: number }>();
    const c = await env.DB.prepare('SELECT private FROM entities WHERE id = ?').bind(privC).first<{ private: number }>();
    expect(a?.private).toBe(0);
    expect(c?.private).toBe(1);
  });
  it('events.private existe e default 0', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(events)').all<{ name: string }>();
    expect((cols.results ?? []).some((x) => x.name === 'private')).toBe(true);
  });
});

describe('callerSeesPrivate — matriz de confiança (header só com proxy token válido)', () => {
  const mk = (h: Record<string, string>) => new Request('https://x/list_entities', { headers: h });
  it('OWNER_TOKEN → true', async () => {
    expect(await callerSeesPrivate(mk({ authorization: `Bearer ${OWNER}` }), env as any)).toBe(true);
  });
  it('proxy token + X-Include-Private:1 → true', async () => {
    expect(await callerSeesPrivate(mk({ authorization: `Bearer ${PROXY}`, 'x-include-private': '1' }), env as any)).toBe(true);
  });
  it('proxy token SEM header → false (fail-closed)', async () => {
    expect(await callerSeesPrivate(mk({ authorization: `Bearer ${PROXY}` }), env as any)).toBe(false);
  });
  it('proxy token + header "0" → false (só "1" conta)', async () => {
    expect(await callerSeesPrivate(mk({ authorization: `Bearer ${PROXY}`, 'x-include-private': '0' }), env as any)).toBe(false);
  });
  it('token ERRADO + header:1 → false (header ignorado)', async () => {
    expect(await callerSeesPrivate(mk({ authorization: 'Bearer lixo-invalido', 'x-include-private': '1' }), env as any)).toBe(false);
  });
  it('SEM Bearer + header:1 → false (header ignorado)', async () => {
    expect(await callerSeesPrivate(mk({ 'x-include-private': '1' }), env as any)).toBe(false);
  });
  it('WRITE token + header:1 → false (não é o proxy read token)', async () => {
    expect(await callerSeesPrivate(mk({ authorization: `Bearer ${WRITE}`, 'x-include-private': '1' }), env as any)).toBe(false);
  });
  it('sessão de cookie (dono) → true', async () => {
    const req = new Request('https://x/app/graph/data', { headers: { cookie: await cookie() } });
    expect(await callerSeesPrivate(req, env as any)).toBe(true);
  });
});

describe('REST list — /list_entities', () => {
  it('proxy SEM header: entidade privada FORA da lista', async () => {
    const j: any = await (await restGet('/list_entities?limit=1000', { token: PROXY })).json();
    const ids = (j.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(pubA);
    expect(ids).not.toContain(privC);
  });
  it('proxy COM header: entidade privada presente', async () => {
    const j: any = await (await restGet('/list_entities?limit=1000', { token: PROXY, header: '1' })).json();
    const ids = (j.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(privC);
  });
  it('OWNER_TOKEN: entidade privada presente', async () => {
    const j: any = await (await restGet('/list_entities?limit=1000', { token: OWNER })).json();
    const ids = (j.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(privC);
  });
});

describe('REST search — /recall_entity (sql_like, sem VECTORIZE no teste)', () => {
  it('proxy SEM header: não acha a entidade privada pelo nome', async () => {
    const j: any = await (await restGet(`/recall_entity?q=${TOKEN_PRIV_NAME}`, { token: PROXY })).json();
    const ids = (j.results ?? []).map((r: any) => r.id);
    expect(ids).not.toContain(privC);
  });
  it('proxy COM header: acha a entidade privada pelo nome', async () => {
    const j: any = await (await restGet(`/recall_entity?q=${TOKEN_PRIV_NAME}`, { token: PROXY, header: '1' })).json();
    const ids = (j.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(privC);
  });
  it('proxy SEM header: observação PRIVADA de contato público NÃO vaza por inferência', async () => {
    const j: any = await (await restGet(`/recall_entity?q=${TOKEN_PRIV_OBS}`, { token: PROXY })).json();
    const ids = (j.results ?? []).map((r: any) => r.id);
    expect(ids).not.toContain(pubA); // o termo só existe na observação privada
  });
  it('OWNER: observação privada alcança o contato na busca textual', async () => {
    const j: any = await (await restGet(`/recall_entity?q=${TOKEN_PRIV_OBS}`, { token: OWNER })).json();
    const ids = (j.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(pubA);
  });
});

describe('REST get — /entities/:id', () => {
  it('proxy SEM header: entidade privada → 404 (indistinguível de inexistente)', async () => {
    const res = await restGet(`/entities/${privC}`, { token: PROXY });
    expect(res.status).toBe(404);
  });
  it('proxy COM header e OWNER: entidade privada → 200', async () => {
    expect((await restGet(`/entities/${privC}`, { token: PROXY, header: '1' })).status).toBe(200);
    expect((await restGet(`/entities/${privC}`, { token: OWNER })).status).toBe(200);
  });
  it('proxy SEM header: contato público omite a conexão com o vizinho privado + observação privada', async () => {
    const j: any = await (await restGet(`/entities/${pubA}`, { token: PROXY })).json();
    const connIds = (j.connections ?? []).map((c: any) => c.otherId ?? c.b_id ?? c.a_id);
    // a conexão pubA↔privC não deve aparecer (vizinho privado)
    expect((j.connections ?? []).some((c: any) => c.b_id === privC || c.a_id === privC)).toBe(false);
    expect(connIds).not.toContain(privC);
    // observação privada fora dos recent_events
    const ctxs = (j.recent_events ?? []).map((e: any) => e.context);
    expect(ctxs.some((c: string) => (c ?? '').includes(TOKEN_PRIV_OBS))).toBe(false);
  });
  it('OWNER: contato público mostra a conexão privada e a observação privada', async () => {
    const j: any = await (await restGet(`/entities/${pubA}`, { token: OWNER })).json();
    expect((j.connections ?? []).some((c: any) => c.b_id === privC || c.a_id === privC)).toBe(true);
    const ctxs = (j.recent_events ?? []).map((e: any) => e.context);
    expect(ctxs.some((c: string) => (c ?? '').includes(TOKEN_PRIV_OBS))).toBe(true);
  });
});

describe('REST get_contact_by_phone', () => {
  it('proxy SEM header: telefone de contato privado não resolve', async () => {
    const j: any = await (await restGet(`/get_contact_by_phone?phone=${PRIV_PHONE}`, { token: PROXY })).json();
    expect(j.match).toBeFalsy();
  });
  it('OWNER: resolve o contato privado por telefone', async () => {
    const j: any = await (await restGet(`/get_contact_by_phone?phone=${PRIV_PHONE}`, { token: OWNER })).json();
    expect(j.match?.id).toBe(privC);
  });
});

describe('Console /app/entity — detalhe', () => {
  it('proxy SEM header: entidade privada → 404', async () => {
    const res = await appGet(`/app/entity?id=${privC}`, { token: PROXY });
    expect(res.status).toBe(404);
  });
  it('proxy COM header e sessão: entidade privada → 200', async () => {
    expect((await appGet(`/app/entity?id=${privC}`, { token: PROXY, header: '1' })).status).toBe(200);
    expect((await appGet(`/app/entity?id=${privC}`, { cookie: await cookie() })).status).toBe(200);
  });
  it('OWNER vê a flag private=true no detalhe', async () => {
    const j: any = await (await appGet(`/app/entity?id=${privC}`, { token: PROXY, header: '1' })).json();
    expect(j.private).toBe(true);
  });
});

describe('Console /app/entity/events — timeline', () => {
  it('proxy SEM header: total e lista excluem a observação privada', async () => {
    const j: any = await (await appGet(`/app/entity/events?id=${pubA}`, { token: PROXY })).json();
    expect(j.total).toBe(1); // só a observação pública
    const ctxs = (j.events ?? []).map((e: any) => e.context);
    expect(ctxs.some((c: string) => (c ?? '').includes(TOKEN_PRIV_OBS))).toBe(false);
  });
  it('proxy COM header: inclui a observação privada e conta as duas', async () => {
    const j: any = await (await appGet(`/app/entity/events?id=${pubA}`, { token: PROXY, header: '1' })).json();
    expect(j.total).toBe(2);
    const ctxs = (j.events ?? []).map((e: any) => e.context);
    expect(ctxs.some((c: string) => (c ?? '').includes(TOKEN_PRIV_OBS))).toBe(true);
  });
  it('proxy SEM header: timeline de entidade privada → 404', async () => {
    expect((await appGet(`/app/entity/events?id=${privC}`, { token: PROXY })).status).toBe(404);
  });
});

describe('Console /app/entity/neighbors — vizinhança', () => {
  it('proxy SEM header: vizinho privado (explícito e similar) fora dos níveis', async () => {
    const j: any = await (await appGet(`/app/entity/neighbors?id=${pubA}`, { token: PROXY })).json();
    const l1 = (j.level1 ?? []).map((n: any) => n.id);
    expect(l1).toContain(pubB);
    expect(l1).not.toContain(privC);
  });
  it('proxy COM header: vizinho privado presente no 1º nível', async () => {
    const j: any = await (await appGet(`/app/entity/neighbors?id=${pubA}`, { token: PROXY, header: '1' })).json();
    const l1 = (j.level1 ?? []).map((n: any) => n.id);
    expect(l1).toContain(privC);
  });
  it('proxy SEM header: ego privado → 404', async () => {
    expect((await appGet(`/app/entity/neighbors?id=${privC}`, { token: PROXY })).status).toBe(404);
  });
});

describe('Console /app/graph/data — grafo', () => {
  it('proxy SEM header: nó privado fora + nenhuma aresta o referencia', async () => {
    const j: any = await (await appGet('/app/graph/data', { token: PROXY })).json();
    const nodeIds = (j.nodes ?? []).map((n: any) => n.id);
    expect(nodeIds).toContain(pubA);
    expect(nodeIds).not.toContain(privC);
    const touchesPriv = (j.edges ?? []).some((e: any) => e.source === privC || e.target === privC);
    expect(touchesPriv).toBe(false);
  });
  it('proxy COM header: nó privado presente', async () => {
    const j: any = await (await appGet('/app/graph/data', { token: PROXY, header: '1' })).json();
    const nodeIds = (j.nodes ?? []).map((n: any) => n.id);
    expect(nodeIds).toContain(privC);
  });
});

describe('embedding — observação privada nunca entra no vetor', () => {
  it('observationsTextFor exclui a observação privada, mantém a pública', async () => {
    const txt = (await observationsTextFor(env as any, pubA)) ?? '';
    expect(txt).toContain('observacao publica normal');
    expect(txt).not.toContain(TOKEN_PRIV_OBS);
  });
});

describe('escrita da flag — one-way + toggle', () => {
  const postOwner = (path: string, body: unknown) =>
    SELF.fetch(`https://x${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('save_person private:true cria contato privado (fora do list sem header)', async () => {
    const r: any = await (await postOwner('/save_person', { name: 'Fulano Sigiloso', private: true })).json();
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare('SELECT private FROM entities WHERE id = ?').bind(r.id).first<{ private: number }>();
    expect(row?.private).toBe(1);
    const list: any = await (await restGet('/list_entities?limit=1000', { token: PROXY })).json();
    expect((list.results ?? []).map((x: any) => x.id)).not.toContain(r.id);
  });

  it('save_person private:false → 400 (desmarcar só na UI)', async () => {
    const res = await postOwner('/save_person', { name: 'Nao Pode', private: false });
    expect(res.status).toBe(400);
  });

  it('log_event private:true grava evento privado (fora da timeline proxy sem header)', async () => {
    const target = await seedEntity({ name: 'Alvo Evento' });
    const r: any = await (await postOwner('/event', { entity_id: target, kind: 'note', context: `${TOKEN_PRIV_OBS}-evt`, private: true })).json();
    expect(r.ok).toBe(true);
    const j: any = await (await appGet(`/app/entity/events?id=${target}`, { token: PROXY })).json();
    expect(j.total).toBe(0);
  });

  it('POST /app/entity/private sem sessão → 302 (redirect)', async () => {
    const res = await SELF.fetch('https://x/app/entity/private', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: pubB, private: true }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('POST /app/entity/private com proxy token (read-only) → 302 (não ganha poder de escrita)', async () => {
    const res = await SELF.fetch('https://x/app/entity/private', {
      method: 'POST',
      headers: { authorization: `Bearer ${PROXY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: pubB, private: true }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const row = await env.DB.prepare('SELECT private FROM entities WHERE id = ?').bind(pubB).first<{ private: number }>();
    expect(row?.private).toBe(0); // nada mudou
  });

  it('toggle com sessão marca e DESMARCA (único caminho que desmarca)', async () => {
    const ck = await cookie();
    const target = await seedEntity({ name: 'Toggle Alvo' });
    // marca
    const r1 = await SELF.fetch('https://x/app/entity/private', {
      method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' },
      body: JSON.stringify({ id: target, private: true }), redirect: 'manual',
    });
    expect(r1.status).toBe(200);
    let row = await env.DB.prepare('SELECT private FROM entities WHERE id = ?').bind(target).first<{ private: number }>();
    expect(row?.private).toBe(1);
    // desmarca
    const r2 = await SELF.fetch('https://x/app/entity/private', {
      method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' },
      body: JSON.stringify({ id: target, private: false }), redirect: 'manual',
    });
    expect(r2.status).toBe(200);
    row = await env.DB.prepare('SELECT private FROM entities WHERE id = ?').bind(target).first<{ private: number }>();
    expect(row?.private).toBe(0);
    // agora visível pro proxy sem header
    const list: any = await (await restGet('/list_entities?limit=1000', { token: PROXY })).json();
    expect((list.results ?? []).map((x: any) => x.id)).toContain(target);
  });
});
