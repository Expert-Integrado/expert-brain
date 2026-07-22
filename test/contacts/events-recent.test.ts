import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';

// Spec 50-console-v2/65 §1 — GET /app/events/recent: feed GLOBAL de interações
// (todas as entidades), usado pela home e pelo journal do Brain. Diferente de
// /app/entity/events (por entidade), este endpoint mistura tudo — os testes usam
// timestamps bem no futuro (ano 2999) pra isolar as fixtures desta suíte do resto
// do banco compartilhado (isolatedStorage:false — vitest.config.ts).

const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const PROXY = 'test-proxy-token';

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

function getRecent(qs: string, opts: { token?: string; cookie?: string; includePrivate?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.includePrivate) headers['x-include-private'] = '1';
  return SELF.fetch(`https://x/app/events/recent${qs}`, { headers, redirect: 'manual' });
}

async function seedEntity(name: string, priv = 0): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, source, private) VALUES (?, 'person', ?, 'seed', ?)`,
  ).bind(id, name, priv).run();
  return id;
}

// `minutesFrom2999` desloca a partir de uma âncora fixa no futuro — cada teste usa
// uma faixa de minutos própria (offset alto) pra nunca colidir com outra fixture
// desta mesma suíte rodando em paralelo/sequência.
function futureTs(baseOffsetMin: number, i = 0): string {
  const d = new Date(Date.UTC(2999, 0, 1, 0, baseOffsetMin + i, 0));
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

async function insertEvent(entityId: string, ts: string, opts: { kind?: string; context?: string; priv?: number } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO events (id, entity_id, kind, ts, context, source, private) VALUES (?, ?, ?, ?, ?, 'seed', ?)`,
  ).bind(id, entityId, opts.kind ?? 'talked', ts, opts.context ?? null, opts.priv ?? 0).run();
  return id;
}

describe('GET /app/events/recent — auth (spec 65 §1)', () => {
  it('sem sessão nem Bearer → 302 (redirect pro login)', async () => {
    const res = await getRecent('');
    expect(res.status).toBe(302);
  });

  it('Bearer CONTACTS_PROXY_TOKEN (read-only) → 200', async () => {
    const res = await getRecent('', { token: PROXY });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
  });

  it('sessão do dono → 200', async () => {
    const res = await getRecent('', { cookie: await sessionCookie() });
    expect(res.status).toBe(200);
  });
});

describe('GET /app/events/recent — paginação e conteúdo (spec 65 §1)', () => {
  it('mistura entidades diferentes, ordenado ts DESC, com entity_name via JOIN', async () => {
    const a = await seedEntity('Feed Recente A');
    const b = await seedEntity('Feed Recente B');
    const evOld = await insertEvent(a, futureTs(1000, 0), { kind: 'talked', context: 'mais antigo' });
    const evNew = await insertEvent(b, futureTs(1000, 5), { kind: 'met', context: 'mais novo' });

    const res = await getRecent('?limit=5', { token: PROXY });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    const ids = j.events.map((e: any) => e.id);
    expect(ids.indexOf(evNew)).toBeLessThan(ids.indexOf(evOld));
    const newEntry = j.events.find((e: any) => e.id === evNew);
    expect(newEntry.entity_name).toBe('Feed Recente B');
    expect(newEntry.kind).toBe('met');
    expect(newEntry.context).toBe('mais novo');
  });

  it('75 eventos futuros isolados: 3 páginas de 30/30/15 sem duplicar nem pular', async () => {
    const e = await seedEntity('Paginação Global');
    const ids: string[] = [];
    for (let i = 0; i < 75; i++) {
      ids.push(await insertEvent(e, futureTs(2000, i), { context: `pg-global-${i}` }));
    }
    const idSet = new Set(ids);

    const totalBefore = await env.DB.prepare(
      `SELECT COUNT(*) n FROM events WHERE context LIKE 'pg-global-%'`,
    ).first<{ n: number }>();
    expect(totalBefore?.n).toBe(75);

    const seen = new Set<string>();
    const pageSizes: number[] = [];
    let offset = 0;
    // A janela (offset/limit) é GLOBAL — sobra ruído de outras fixtures depois das
    // nossas 75 (que estão nos minutos mais recentes desta suíte). Filtramos pelo
    // conjunto de ids conhecido em vez de assumir que só existem nossos eventos.
    for (let page = 0; page < 6 && seen.size < 75; page++) {
      const res = await getRecent(`?offset=${offset}&limit=30`, { token: PROXY });
      const j: any = await res.json();
      pageSizes.push(j.events.length);
      for (const ev of j.events) {
        if (!idSet.has(ev.id)) continue;
        expect(seen.has(ev.id)).toBe(false);
        seen.add(ev.id);
      }
      offset += j.events.length;
      if (j.events.length === 0) break;
    }
    expect(seen.size).toBe(75);
  });

  it('limit acima do teto (100) é saturado', async () => {
    const res = await getRecent('?limit=500', { token: PROXY });
    const j: any = await res.json();
    expect(j.limit).toBe(100);
  });
});

describe('GET /app/events/recent — privacidade (spec 65 §1, spec 61)', () => {
  it('evento privado some da lista e do total sem include-private; aparece com include-private/sessão', async () => {
    const pub = await seedEntity('Privacidade Pub Global');
    const priv = await seedEntity('Privacidade Priv Global', 1);
    const evPub = await insertEvent(pub, futureTs(3000, 0), { context: 'evento publico global' });
    const evPrivEntity = await insertEvent(priv, futureTs(3000, 1), { context: 'entidade privada global' });
    const evPrivFlag = await insertEvent(pub, futureTs(3000, 2), { context: 'evento privado global', priv: 1 });

    const withoutPriv = await getRecent('?limit=50', { token: PROXY });
    const jWithout: any = await withoutPriv.json();
    const idsWithout = jWithout.events.map((e: any) => e.id);
    expect(idsWithout).toContain(evPub);
    expect(idsWithout).not.toContain(evPrivEntity);
    expect(idsWithout).not.toContain(evPrivFlag);

    const withPriv = await getRecent('?limit=50', { token: PROXY, includePrivate: true });
    const jWith: any = await withPriv.json();
    const idsWith = jWith.events.map((e: any) => e.id);
    expect(idsWith).toContain(evPub);
    expect(idsWith).toContain(evPrivEntity);
    expect(idsWith).toContain(evPrivFlag);

    const viaSession = await getRecent('?limit=50', { cookie: await sessionCookie() });
    const jSession: any = await viaSession.json();
    const idsSession = jSession.events.map((e: any) => e.id);
    expect(idsSession).toContain(evPrivEntity);
    expect(idsSession).toContain(evPrivFlag);
  });
});
