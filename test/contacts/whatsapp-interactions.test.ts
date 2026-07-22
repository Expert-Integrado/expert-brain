import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../src/contacts/db/migrate';
import {
  importWaInteractions, sanitizePairs, interactionStrength,
  WAINTERACTIONS_KV, WAINTERACTIONS_WHY_PREFIX,
} from '../../src/contacts/whatsapp/interactions';
import { CONN_TYPES, SYMMETRIC_CONN_TYPES } from '../../src/contacts/canon';

// Grafo social: interações → conexões interacts_with (specs/whatsapp-interactions.md).
// Dados 100% fictícios (repo público): Ana Almeida, Bruno Castro, Carla Dias.

const E = env as any;

const seedPerson = async (id: string, name: string, phone: string | null) => {
  await E.DB.prepare(
    `INSERT OR REPLACE INTO entities (id, kind, name, phone, source) VALUES (?, 'person', ?, ?, 'seed')`
  ).bind(id, name, phone).run();
};

const connOf = async (aId: string, bId: string) => {
  const [x, y] = aId < bId ? [aId, bId] : [bId, aId];
  return E.DB.prepare(
    `SELECT * FROM connections WHERE a_id = ? AND b_id = ? AND type = 'interacts_with'`
  ).bind(x, y).first();
};

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await E.CACHE.delete(WAINTERACTIONS_KV.lastRun);
  await E.DB.prepare(`DELETE FROM connections WHERE type = 'interacts_with'`).run();
});

describe('canon', () => {
  it('interacts_with existe e é simétrico', () => {
    expect(CONN_TYPES).toContain('interacts_with');
    expect(SYMMETRIC_CONN_TYPES).toContain('interacts_with');
  });
});

describe('sanitizePairs', () => {
  it('valida shape e descarta par sem telefone ou sem replies >= 1', () => {
    expect(sanitizePairs({})).toBeNull();
    expect(sanitizePairs({ pairs: 'x' })).toBeNull();
    const out = sanitizePairs({
      pairs: [
        { a_phone: '5511911110001', b_phone: '5511911110002', replies: 3.9, groups: ['Grupo Mentoria (ficticio)'] },
        { a_phone: '', b_phone: '5511911110002', replies: 2 },
        { a_phone: '5511911110001', b_phone: '5511911110002', replies: 0 },
        { a_phone: '5511911110001', b_phone: '5511911110003', replies: 1, groups: 'nao-array' },
      ],
    });
    expect(out).toEqual([
      { a_phone: '5511911110001', b_phone: '5511911110002', replies: 3, groups: ['Grupo Mentoria (ficticio)'] },
      { a_phone: '5511911110001', b_phone: '5511911110003', replies: 1, groups: [] },
    ]);
  });
});

describe('interactionStrength', () => {
  it('cresce com replies e trava em 0.8 (nunca compete com vínculo declarado)', () => {
    expect(interactionStrength(1)).toBeCloseTo(0.32);
    expect(interactionStrength(10)).toBeCloseTo(0.5);
    expect(interactionStrength(500)).toBe(0.8);
  });
});

describe('importWaInteractions — engine', () => {
  it('conecta SÓ pares onde as duas pontas já são contatos (variantes de telefone)', async () => {
    const pa = crypto.randomUUID(), pb = crypto.randomUUID();
    // Ana salva SEM o 9º dígito — o par chega COM; variantes casam.
    await seedPerson(pa, 'Ana Almeida', '551133330001');
    await seedPerson(pb, 'Bruno Castro', '5511955550002');
    const r = await importWaInteractions(E, [
      { a_phone: '5511933330001', b_phone: '5511955550002', replies: 4, groups: ['Grupo Mentoria (ficticio)'] },
      { a_phone: '5511900009999', b_phone: '5511955550002', replies: 2, groups: [] }, // ponta desconhecida
    ], 90);
    expect(r.connections_created).toBe(1);
    expect(r.skipped_unknown).toBe(1);
    const c = await connOf(pa, pb);
    expect(c).not.toBeNull();
    expect(c.strength).toBeCloseTo(0.38);
    expect(c.why).toContain(WAINTERACTIONS_WHY_PREFIX);
    expect(c.why).toContain('90 dias');
    expect(c.why).toContain('Grupo Mentoria (ficticio)');
  });

  it('re-push atualiza strength/why do edge do sync (idempotente, sem duplicar)', async () => {
    const pa = crypto.randomUUID(), pb = crypto.randomUUID();
    await seedPerson(pa, 'Ana Almeida', '5511933330011');
    await seedPerson(pb, 'Bruno Castro', '5511955550012');
    await importWaInteractions(E, [{ a_phone: '5511933330011', b_phone: '5511955550012', replies: 2, groups: [] }], 90);
    // Par invertido no segundo push: normalização simétrica colide no mesmo edge.
    const r2 = await importWaInteractions(E, [{ a_phone: '5511955550012', b_phone: '5511933330011', replies: 10, groups: ['Grupo Beta'] }], 90);
    expect(r2.connections_created).toBe(0);
    expect(r2.connections_updated).toBe(1);
    const n = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM connections WHERE type = 'interacts_with' AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))`
    ).bind(pa, pb, pb, pa).first();
    expect(n.n).toBe(1);
    const c = await connOf(pa, pb);
    expect(c.strength).toBeCloseTo(0.5);
    expect(c.why).toContain('Grupo Beta');
  });

  it('edge interacts_with MANUAL (why sem marcador) nunca é tocado', async () => {
    const pa = crypto.randomUUID(), pb = crypto.randomUUID();
    await seedPerson(pa, 'Ana Almeida', '5511933330021');
    await seedPerson(pb, 'Carla Dias', '5511955550022');
    const [x, y] = pa < pb ? [pa, pb] : [pb, pa];
    const manualWhy = 'Se falam toda semana sobre o projeto X (registrado pelo dono)';
    await E.DB.prepare(
      `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, 'interacts_with', 0.9, ?)`
    ).bind(crypto.randomUUID(), x, y, manualWhy).run();
    const r = await importWaInteractions(E, [{ a_phone: '5511933330021', b_phone: '5511955550022', replies: 8, groups: [] }], 90);
    expect(r.connections_created).toBe(0);
    expect(r.connections_updated).toBe(0);
    const c = await connOf(pa, pb);
    expect(c.strength).toBe(0.9);
    expect(c.why).toBe(manualWhy);
  });

  it('auto-par (mesma pessoa nas duas pontas via variantes) é descartado', async () => {
    const pa = crypto.randomUUID();
    await seedPerson(pa, 'Ana Almeida', '5511933330031');
    const r = await importWaInteractions(E, [
      { a_phone: '5511933330031', b_phone: '551133330031', replies: 3, groups: [] },
    ], 90);
    expect(r.skipped_self).toBe(1);
    expect(r.connections_created).toBe(0);
  });

  it('grava resumo da rodada em KV pro painel (wainteractions:last_run)', async () => {
    await importWaInteractions(E, [], 30);
    const raw = await E.CACHE.get(WAINTERACTIONS_KV.lastRun);
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.at).toBeTruthy();
  });
});
