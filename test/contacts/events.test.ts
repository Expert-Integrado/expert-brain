import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';

// Spec 50-console-v2/57 — timeline paginada de interações + registro manual pelo
// console (sessão OU Bearer CONTACTS_WRITE_TOKEN escopado, allowlist de 1 path).

const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const OWNER = 'test-owner-token';
const PROXY = 'test-proxy-token';
const WRITE = 'test-write-token';

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

async function seedEntity(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', ?, 'seed')`,
  ).bind(id, (overrides.name as string) ?? 'Evento Teste').run();
  return id;
}

async function readEntity(id: string): Promise<any> {
  return env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<any>();
}

function getEvents(path: string, opts: { token?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return SELF.fetch(`https://x${path}`, { headers, redirect: 'manual' });
}

function postEvent(path: string, body: unknown, opts: { token?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' });
}

const restEvent = (body: unknown) =>
  SELF.fetch('https://x/event', {
    method: 'POST',
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /app/entity/events — paginação estável (spec 57, critério 1)', () => {
  it('75 eventos: 3 páginas de 30/30/15, sem duplicar item entre páginas', async () => {
    const cookie = await sessionCookie();
    const id = await seedEntity({ name: 'Paginação' });
    // Insere 75 eventos com ts distintos e determinísticos (evita empate de mesmo ts).
    for (let i = 0; i < 75; i++) {
      await env.DB.prepare(
        `INSERT INTO events (id, entity_id, kind, ts, context, source)
         VALUES (?, ?, 'talked', datetime('now', ?), ?, 'manual')`,
      ).bind(crypto.randomUUID(), id, `-${i} minutes`, `evento ${i}`).run();
    }

    const seenIds = new Set<string>();
    const pageSizes: number[] = [];
    let offset = 0;
    let total = -1;
    for (let page = 0; page < 3; page++) {
      const res = await getEvents(`/app/entity/events?id=${id}&offset=${offset}&limit=30`, { cookie });
      expect(res.status).toBe(200);
      const j: any = await res.json();
      expect(j.ok).toBe(true);
      total = j.total;
      pageSizes.push(j.events.length);
      for (const ev of j.events) {
        expect(seenIds.has(ev.id)).toBe(false);
        seenIds.add(ev.id);
      }
      offset += j.events.length;
    }
    expect(total).toBe(75);
    expect(pageSizes).toEqual([30, 30, 15]);
    expect(seenIds.size).toBe(75);
  });

  it('id ausente → 400', async () => {
    const cookie = await sessionCookie();
    const res = await getEvents('/app/entity/events?offset=0&limit=10', { cookie });
    expect(res.status).toBe(400);
  });

  it('entidade inexistente → 404', async () => {
    const cookie = await sessionCookie();
    const res = await getEvents(`/app/entity/events?id=${crypto.randomUUID()}`, { cookie });
    expect(res.status).toBe(404);
  });

  it('sem sessão nem Bearer → 302 (redirect pro login)', async () => {
    const id = await seedEntity();
    const res = await getEvents(`/app/entity/events?id=${id}`);
    expect(res.status).toBe(302);
  });

  it('Bearer CONTACTS_PROXY_TOKEN (read-only) → 200', async () => {
    const id = await seedEntity();
    const res = await getEvents(`/app/entity/events?id=${id}`, { token: PROXY });
    expect(res.status).toBe(200);
  });
});

describe('log_event / recordEvent — kinds novos (spec 57, critério 2)', () => {
  it('meeting/email/message são aceitos e persistem', async () => {
    for (const kind of ['meeting', 'email', 'message']) {
      const id = await seedEntity({ name: `Kind ${kind}` });
      const res = await restEvent({ entity_id: id, kind, context: `via ${kind}` });
      expect(res.status).toBe(200);
      const cnt = await env.DB.prepare(
        "SELECT COUNT(*) c FROM events WHERE entity_id = ? AND kind = ?",
      ).bind(id, kind).first<{ c: number }>();
      expect(cnt?.c).toBe(1);
    }
  });

  it('meeting atualiza last_contacted (mesma regra de met/talked/note)', async () => {
    const id = await seedEntity({ name: 'Meeting LC' });
    expect((await readEntity(id)).last_contacted).toBeNull();
    const res = await restEvent({ entity_id: id, kind: 'meeting', context: 'reunião de alinhamento' });
    expect(res.status).toBe(200);
    expect((await readEntity(id)).last_contacted).toBeTruthy();
  });

  it('email e message NÃO atualizam last_contacted (mesma regra de saw_post)', async () => {
    for (const kind of ['email', 'message']) {
      const id = await seedEntity({ name: `No LC ${kind}` });
      const res = await restEvent({ entity_id: id, kind, context: `sem lc ${kind}` });
      expect(res.status).toBe(200);
      expect((await readEntity(id)).last_contacted).toBeNull();
    }
  });
});

describe('POST /app/entity/event — validação (spec 57, critério 6)', () => {
  it('entity_id ausente → 400', async () => {
    const cookie = await sessionCookie();
    const res = await postEvent('/app/entity/event', { kind: 'talked' }, { cookie });
    expect(res.status).toBe(400);
  });

  it('kind inválido → 400 com lista dos válidos', async () => {
    const cookie = await sessionCookie();
    const id = await seedEntity();
    const res = await postEvent('/app/entity/event', { entity_id: id, kind: 'inexistente' }, { cookie });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toContain('invalid kind');
    expect(j.allowed).toContain('meeting');
  });

  it('entidade inexistente → 404', async () => {
    const cookie = await sessionCookie();
    const res = await postEvent('/app/entity/event', { entity_id: crypto.randomUUID(), kind: 'talked' }, { cookie });
    expect(res.status).toBe(404);
  });
});

describe('Matriz de auth do write endpoint (spec 57, critério 4)', () => {
  it('CONTACTS_WRITE_TOKEN em POST /app/entity/event → 200 (correto)', async () => {
    const id = await seedEntity({ name: 'Write token ok' });
    const res = await postEvent('/app/entity/event', { entity_id: id, kind: 'talked', context: 'via write token' }, { token: WRITE });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
  });

  it('CONTACTS_WRITE_TOKEN em qualquer OUTRO path → 401', async () => {
    const res1 = await getEvents('/app/graph/data', { token: WRITE });
    expect(res1.status).toBe(401);
    const id = await seedEntity();
    const res2 = await getEvents(`/app/entity/events?id=${id}`, { token: WRITE });
    expect(res2.status).toBe(401);
  });

  it('CONTACTS_WRITE_TOKEN com método errado no MESMO path → 401', async () => {
    const id = await seedEntity();
    const res = await getEvents(`/app/entity/event?id=${id}`, { token: WRITE });
    expect(res.status).toBe(401);
  });

  it('CONTACTS_PROXY_TOKEN (read-only) em POST /app/entity/event → 401 (não regride o design read-only)', async () => {
    const id = await seedEntity();
    const res = await postEvent('/app/entity/event', { entity_id: id, kind: 'talked' }, { token: PROXY });
    expect(res.status).toBe(401);
  });

  it('token aleatório em POST /app/entity/event → 401', async () => {
    const id = await seedEntity();
    const res = await postEvent('/app/entity/event', { entity_id: id, kind: 'talked' }, { token: 'lixo-qualquer' });
    expect(res.status).toBe(401);
  });

  it('sem token e sem sessão → 302 (cai pro gate de sessão do console standalone)', async () => {
    const id = await seedEntity();
    const res = await postEvent('/app/entity/event', { entity_id: id, kind: 'talked' });
    expect(res.status).toBe(302);
  });
});

describe('recordEvent compartilhado — evento idêntico nos 3 call-sites (spec 57, critério 3)', () => {
  it('REST, console (sessão) e proxy do Brain (write token) gravam evento equivalente + atualizam last_contacted', async () => {
    const cookie = await sessionCookie();

    // 1. REST /event (OWNER_TOKEN)
    const idRest = await seedEntity({ name: 'Call-site REST' });
    const r1 = await restEvent({ entity_id: idRest, kind: 'meeting', context: 'reunião via REST' });
    expect(r1.status).toBe(200);
    expect((await readEntity(idRest)).last_contacted).toBeTruthy();
    const evRest = await env.DB.prepare("SELECT kind, context, source FROM events WHERE entity_id = ?").bind(idRest).first<any>();
    expect(evRest).toEqual({ kind: 'meeting', context: 'reunião via REST', source: 'manual' });

    // 2. Console standalone (sessão de cookie)
    const idSession = await seedEntity({ name: 'Call-site sessão' });
    const r2 = await postEvent('/app/entity/event', { entity_id: idSession, kind: 'meeting', context: 'reunião via sessão' }, { cookie });
    expect(r2.status).toBe(200);
    expect((await readEntity(idSession)).last_contacted).toBeTruthy();
    const evSession = await env.DB.prepare("SELECT kind, context, source FROM events WHERE entity_id = ?").bind(idSession).first<any>();
    expect(evSession).toEqual({ kind: 'meeting', context: 'reunião via sessão', source: 'manual' });

    // 3. Proxy de escrita do Brain (Bearer CONTACTS_WRITE_TOKEN)
    const idProxy = await seedEntity({ name: 'Call-site proxy Brain' });
    const r3 = await postEvent('/app/entity/event', { entity_id: idProxy, kind: 'meeting', context: 'reunião via proxy Brain' }, { token: WRITE });
    expect(r3.status).toBe(200);
    expect((await readEntity(idProxy)).last_contacted).toBeTruthy();
    const evProxy = await env.DB.prepare("SELECT kind, context, source FROM events WHERE entity_id = ?").bind(idProxy).first<any>();
    expect(evProxy).toEqual({ kind: 'meeting', context: 'reunião via proxy Brain', source: 'manual' });
  });
});

describe('Sources de canal (adendo 12/07 em 9zfjcquprh03) — instagram/email/telegram', () => {
  it('instagram, email e telegram são aceitos e persistem como source', async () => {
    for (const source of ['instagram', 'email', 'telegram']) {
      const id = await seedEntity({ name: `Source ${source}` });
      const res = await restEvent({ entity_id: id, kind: 'note', context: `fato via ${source}`, source });
      expect(res.status).toBe(200);
      const ev = await env.DB.prepare('SELECT source FROM events WHERE entity_id = ?').bind(id).first<any>();
      expect(ev?.source).toBe(source);
    }
  });

  it('source inválido continua 400 com a lista dos válidos', async () => {
    const id = await seedEntity();
    const res = await restEvent({ entity_id: id, kind: 'note', context: 'x', source: 'fax' });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toContain('invalid source');
    expect(j.detail.allowed).toContain('instagram');
  });
});

describe('last_contacted acompanha o ts do EVENTO, nunca retrocede (adendo 11/07 em 9zfjcquprh03)', () => {
  it('evento histórico em entidade virgem → last_contacted = ts do evento (normalizado), não a hora da gravação', async () => {
    const id = await seedEntity({ name: 'LC histórico' });
    const res = await restEvent({ entity_id: id, kind: 'note', context: 'fato de 2024', ts: '2024-01-17T12:00:00.000-03:00' });
    expect(res.status).toBe(200);
    expect((await readEntity(id)).last_contacted).toBe('2024-01-17 15:00:00');
  });

  it('evento histórico NÃO retrocede um last_contacted mais recente', async () => {
    const id = await seedEntity({ name: 'LC não retrocede' });
    await env.DB.prepare("UPDATE entities SET last_contacted = '2026-06-30 10:00:00' WHERE id = ?").bind(id).run();
    const res = await restEvent({ entity_id: id, kind: 'meeting', context: 'reunião antiga', ts: '2023-05-05T09:00:00Z' });
    expect(res.status).toBe(200);
    expect((await readEntity(id)).last_contacted).toBe('2026-06-30 10:00:00');
  });

  it('evento com ts mais novo que o atual avança pro ts do evento', async () => {
    const id = await seedEntity({ name: 'LC avança' });
    await env.DB.prepare("UPDATE entities SET last_contacted = '2025-01-01 00:00:00' WHERE id = ?").bind(id).run();
    const res = await restEvent({ entity_id: id, kind: 'talked', context: 'conversa recente', ts: '2026-02-02T18:30:00Z' });
    expect(res.status).toBe(200);
    expect((await readEntity(id)).last_contacted).toBe('2026-02-02 18:30:00');
  });

  it('evento sem ts mantém o comportamento atual (now)', async () => {
    const id = await seedEntity({ name: 'LC sem ts' });
    const res = await restEvent({ entity_id: id, kind: 'talked', context: 'agora' });
    expect(res.status).toBe(200);
    const lc = (await readEntity(id)).last_contacted;
    expect(lc).toBeTruthy();
    expect(lc.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });

  it('ts inválido não quebra: cai pra now', async () => {
    const id = await seedEntity({ name: 'LC ts inválido' });
    const res = await restEvent({ entity_id: id, kind: 'note', context: 'ts lixo', ts: 'não-é-data' });
    expect(res.status).toBe(200);
    expect((await readEntity(id)).last_contacted).toBeTruthy();
  });
});

describe('Dedupe de double-submit (spec 57, riscos e reversão)', () => {
  it('mesma entity+kind+context em <5s → idempotente (mesmo id, não duplica linha)', async () => {
    const cookie = await sessionCookie();
    const id = await seedEntity({ name: 'Dedupe' });
    const body = { entity_id: id, kind: 'talked', context: 'ligação rápida sobre o projeto' };
    const r1 = await postEvent('/app/entity/event', body, { cookie });
    const j1: any = await r1.json();
    const r2 = await postEvent('/app/entity/event', body, { cookie });
    const j2: any = await r2.json();
    expect(j1.id).toBe(j2.id);
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM events WHERE entity_id = ?").bind(id).first<{ c: number }>();
    expect(cnt?.c).toBe(1);
  });

  it('contextos diferentes na mesma entidade NÃO dedupe', async () => {
    const cookie = await sessionCookie();
    const id = await seedEntity({ name: 'Sem dedupe' });
    await postEvent('/app/entity/event', { entity_id: id, kind: 'talked', context: 'primeira ligação' }, { cookie });
    await postEvent('/app/entity/event', { entity_id: id, kind: 'talked', context: 'segunda ligação' }, { cookie });
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM events WHERE entity_id = ?").bind(id).first<{ c: number }>();
    expect(cnt?.c).toBe(2);
  });
});
