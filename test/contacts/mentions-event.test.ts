import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// Integração do evento de MENÇÃO (spec 50-console-v2/62 §3.1). O Brain, ao criar uma
// menção nota↔contato, dispara POST /app/entity/event com kind `mentioned_in_brain` via
// o CONTACTS_WRITE_TOKEN escopado (allowlist de 1 path — spec 57). Este teste vive no
// lado contacts: nenhum código novo foi necessário aqui (o kind já existia no enum e o
// write path da 57 já aceita o token) — só a garantia de que o evento é aceito, gravado
// e que NÃO conta como "contato" (não mexe em last_contacted).

const WRITE = 'test-write-token';
const PROXY = 'test-proxy-token';

async function seedEntity(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', 'Menção Teste', 'seed')`,
  ).bind(id).run();
  return id;
}

function postEvent(body: unknown, token = WRITE) {
  return SELF.fetch('https://x/app/entity/event', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

describe('evento mentioned_in_brain (spec 62 §3)', () => {
  it('write token grava o evento na timeline com kind/source corretos', async () => {
    const id = await seedEntity();
    const res = await postEvent({
      entity_id: id,
      kind: 'mentioned_in_brain',
      context: 'Reunião com o cliente · https://brain.example/app/notes/abc',
      source: 'brain_bridge',
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);

    const row = await env.DB.prepare(
      `SELECT kind, source, context FROM events WHERE entity_id = ? ORDER BY ts DESC LIMIT 1`,
    ).bind(id).first<any>();
    expect(row.kind).toBe('mentioned_in_brain');
    expect(row.source).toBe('brain_bridge');
    expect(row.context).toContain('Reunião');
  });

  it('menção NÃO atualiza last_contacted (não é interação real com a pessoa)', async () => {
    const id = await seedEntity();
    expect((await env.DB.prepare('SELECT last_contacted FROM entities WHERE id = ?').bind(id).first<any>()).last_contacted).toBeNull();
    await postEvent({ entity_id: id, kind: 'mentioned_in_brain', context: 'citado', source: 'brain_bridge' });
    const after = await env.DB.prepare('SELECT last_contacted FROM entities WHERE id = ?').bind(id).first<any>();
    expect(after.last_contacted).toBeNull();
  });

  it('o proxy token READ-ONLY não pode gravar a menção (fail-closed)', async () => {
    const id = await seedEntity();
    const res = await postEvent({ entity_id: id, kind: 'mentioned_in_brain', context: 'x', source: 'brain_bridge' }, PROXY);
    expect(res.status).toBe(401);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE entity_id = ?').bind(id).first<any>();
    expect(count.n).toBe(0);
  });

  it('a menção aparece na timeline paginada do contato (GET via proxy)', async () => {
    const id = await seedEntity();
    await postEvent({ entity_id: id, kind: 'mentioned_in_brain', context: 'citado no brain', source: 'brain_bridge' });
    const res = await SELF.fetch(`https://x/app/entity/events?id=${id}&offset=0&limit=30`, {
      headers: { authorization: `Bearer ${PROXY}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.events.some((e: any) => e.kind === 'mentioned_in_brain')).toBe(true);
  });
});
