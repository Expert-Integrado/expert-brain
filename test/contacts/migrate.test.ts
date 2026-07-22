import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/contacts/db/migrate';

// Spec 40-ops/44 — migrations rastreadas com baseline pra banco vivo.
//
// O D1 do harness (test/apply-migrations.ts) já vem com o schema v0.4 (entities +
// category) aplicado ANTES de runMigrations rodar — ou seja, simula EXATAMENTE o
// "banco de produção pré-tracking": schema presente, _migrations ausente. É o ramo
// crítico (a 0002 tem DROP TABLE e NUNCA pode re-executar lá).

const OWNER = 'test-owner-token';
const post = (path: string, token = OWNER) =>
  SELF.fetch(`https://x${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

async function migrationIds(): Promise<string[]> {
  const r = await env.DB.prepare('SELECT id FROM _migrations ORDER BY id').all<{ id: string }>();
  return (r.results ?? []).map((x) => x.id);
}
async function tableExists(name: string): Promise<boolean> {
  const t = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).bind(name).first();
  return !!t;
}

describe('runMigrations — baseline em banco vivo (schema presente, _migrations vazia)', () => {
  it('marca 0001-0003 como legacy sem re-executar DDL; dados intactos', async () => {
    // seed uma linha ANTES de rodar — se a 0002 re-executasse (DROP TABLE), sumiria.
    const seedId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', 'Baseline Seed', 'seed')`
    ).bind(seedId).run();

    await runMigrations(env);

    const ids = await migrationIds();
    // 0001-0003 legacy + 0004 (nova, roda de fato)
    expect(ids).toContain('0001_initial_schema');
    expect(ids).toContain('0002_entities');
    expect(ids).toContain('0003_category');
    expect(ids).toContain('0004_media_dedup_index');

    // schema v0.4 continua íntegro
    expect(await tableExists('entities')).toBe(true);
    expect(await tableExists('connections')).toBe(true);
    expect(await tableExists('events')).toBe(true);
    expect(await tableExists('media')).toBe(true);

    // a linha seed sobreviveu (prova de que a 0002 NÃO re-executou)
    const still = await env.DB.prepare('SELECT id FROM entities WHERE id = ?').bind(seedId).first();
    expect(still).not.toBeNull();

    // índice da 0004 existe
    const idx = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_media_entity_hash'`
    ).first();
    expect(idx).not.toBeNull();
  });

  it('idempotente: rodar de novo não muda o conjunto de ids', async () => {
    const before = await migrationIds();
    await runMigrations(env);
    const after = await migrationIds();
    expect(after).toEqual(before);
  });
});

describe('POST /setup/provision (spec 44 §2)', () => {
  it('sem token → 401', async () => {
    const res = await SELF.fetch('https://x/setup/provision', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('com CONTACTS_PROXY_TOKEN (GET-only) → 401', async () => {
    const res = await post('/setup/provision', 'test-proxy-token');
    expect(res.status).toBe(401);
  });

  it('com OWNER_TOKEN → 200 com lista de migrations', async () => {
    const res = await post('/setup/provision');
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    const ids = (j.migrations ?? []).map((m: any) => m.id);
    expect(ids).toContain('0001_initial_schema');
    expect(ids).toContain('0004_media_dedup_index');
  });

  it('dupla chamada → mesmo estado (idempotência via endpoint)', async () => {
    const a: any = await (await post('/setup/provision')).json();
    const b: any = await (await post('/setup/provision')).json();
    expect((b.migrations ?? []).map((m: any) => m.id)).toEqual((a.migrations ?? []).map((m: any) => m.id));
  });
});

// Contador de falhas do cron de manutenção (spec 40-ops/43; contrato da 10-backend/22).
describe('trackMaintOutcome', () => {
  it('falha incrementa e grava maint:alert; sucesso zera', async () => {
    const { trackMaintOutcome } = await import('../../src/contacts/index');
    const { env } = await import('cloudflare:test');
    const E = env as any;
    await E.CACHE.delete('maint:consecutive_failures');
    await E.CACHE.delete('maint:alert');

    await trackMaintOutcome(E, false, 'boom');
    await trackMaintOutcome(E, false, 'boom2');
    expect(await E.CACHE.get('maint:consecutive_failures')).toBe('2');
    const alert = JSON.parse((await E.CACHE.get('maint:alert'))!);
    expect(alert.kind).toBe('maint_sync_failing');
    expect(alert.consecutive).toBe(2);
    expect(alert.message).toBe('boom2');

    await trackMaintOutcome(E, true);
    expect(await E.CACHE.get('maint:consecutive_failures')).toBe('0');
  });

  it('erro do KV nao propaga', async () => {
    const { trackMaintOutcome } = await import('../../src/contacts/index');
    const broken = {
      CACHE: {
        get: async () => { throw new Error('kv down'); },
        put: async () => { throw new Error('kv down'); },
      },
    } as any;
    await expect(trackMaintOutcome(broken, false, 'x')).resolves.toBeUndefined();
  });
});
