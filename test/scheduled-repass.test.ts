import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { runScheduled, BACKUP_CRON } from '../src/scheduled.js';
import { replaceSimilarEdges } from '../src/db/queries.js';
import { LAST_BACKUP_META_KEY } from '../src/backup/snapshot.js';
import { RESURFACE_DIGEST_META_KEY } from '../src/digest/resurface.js';
// TDD da spec 70-grafo-higiene/72 — o módulo ainda NÃO existe: este import falha
// inteiro até o PR2 entrar (red de coleção, esperado).
import { REPASS_CRON, runSimilarRepass } from '../src/graph/repass.js';

const E = env as any;
const NOW = 1_800_000_000_000; // instante fixo (Date.now é proibido em teste de janela)
const H = 3_600_000;
const WATERMARK_KEY = 'repass:watermark';

// Contexto forjado, mesmo padrão de test/scheduled.test.ts
function fakeCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(waits) };
}

// Vectorize forjado com getByIds (o re-pass NUNCA re-embeda — lê o vetor do índice).
// Cada nota ganha um vetor com assinatura no 1º componente; query() resolve os
// vizinhos por essa assinatura, permitindo controlar o retorno POR nota.
function fakeVectorize(
  vectors: Record<string, number>,
  neighborsBySig: Record<number, Array<{ id: string; score: number }>> = {},
  opts: { throwOnSig?: number } = {}
) {
  return {
    upsert: vi.fn(async () => ({})),
    getByIds: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => vectors[id] !== undefined)
        .map((id) => ({ id, values: [vectors[id], ...Array(1023).fill(0)] }))
    ),
    query: vi.fn(async (values: number[]) => {
      if (opts.throwOnSig !== undefined && values[0] === opts.throwOnSig) {
        throw new Error('vectorize query falhou pra esta nota');
      }
      return { matches: neighborsBySig[values[0]] ?? [] };
    }),
  };
}

async function seedNote(
  id: string, updatedAt: number,
  opts: { kind?: string | null; deletedAt?: number | null } = {}
): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, `Nota ${id}`, 'corpo', `tldr da nota ${id}`, '["operations"]',
    opts.kind === undefined ? 'concept' : opts.kind,
    updatedAt, updatedAt, opts.deletedAt ?? null
  ).run();
}

async function similarEdgeTargets(fromId: string): Promise<string[]> {
  const r = await E.DB.prepare(
    'SELECT to_id FROM similar_edges WHERE from_id = ? ORDER BY score DESC'
  ).bind(fromId).all();
  return (r.results ?? []).map((row: any) => row.to_id);
}

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await E.DB.prepare('DELETE FROM similar_edges').run();
  await E.DB.prepare('DELETE FROM notes').run();
  await E.DB.prepare('DELETE FROM meta WHERE key = ?').bind(LAST_BACKUP_META_KEY).run();
  await E.DB.prepare('DELETE FROM meta WHERE key = ?').bind(RESURFACE_DIGEST_META_KEY).run();
  await E.GRAPH_CACHE.delete(WATERMARK_KEY);
  E.VECTORIZE = fakeVectorize({});
});

describe('REPASS_CRON — dispatch (spec 72)', () => {
  it('a expressão bate com a do wrangler.toml e é distinta das existentes', () => {
    // Se mudar em [triggers].crons, TEM que mudar aqui — e o braço no dispatch
    // TEM que ir no MESMO deploy (fail-safe manda desconhecida pro fluxo diário).
    expect(REPASS_CRON).toBe('0 8 * * *');
    expect(REPASS_CRON).not.toBe(BACKUP_CRON);
    expect(REPASS_CRON).not.toBe('0 11 * * *');
  });

  it('runScheduled(REPASS_CRON) NÃO cai no fluxo diário nem no backup', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled(REPASS_CRON, E, ctx);
    await settle();
    // Hoje o fail-safe jogaria a expressão desconhecida no fluxo diário, que
    // computa e grava o resurface digest — o braço novo impede exatamente isso.
    const resurface = await E.DB.prepare('SELECT value FROM meta WHERE key = ?')
      .bind(RESURFACE_DIGEST_META_KEY).first();
    expect(resurface).toBeNull();
    const backup = await E.DB.prepare('SELECT value FROM meta WHERE key = ?')
      .bind(LAST_BACKUP_META_KEY).first();
    expect(backup).toBeNull();
  });
});

describe('runSimilarRepass — janela de 48h (spec 72)', () => {
  it('reprocessa nota recente sem similar_edges e grava os vizinhos', async () => {
    await seedNote('r1', NOW - 1 * H);
    await seedNote('viz', NOW - 72 * H); // alvo dos vizinhos (FK viva, FORA da janela)
    E.VECTORIZE = fakeVectorize({ r1: 1, viz: 2 }, { 1: [{ id: 'viz', score: 0.7 }] });
    const result = await runSimilarRepass(E, NOW);
    expect(result.refreshed).toBeGreaterThanOrEqual(1);
    expect(await similarEdgeTargets('r1')).toEqual(['viz']);
    expect(E.AI?.run).toBeUndefined(); // nunca re-embeda — só getByIds + query
  });

  it('exclui task, nota deletada e nota fora da janela de 48h', async () => {
    await seedNote('t1', NOW - 1 * H, { kind: 'task' });
    await seedNote('d1', NOW - 1 * H, { deletedAt: NOW - 1 * H });
    await seedNote('old1', NOW - 72 * H);
    E.VECTORIZE = fakeVectorize({ t1: 1, d1: 2, old1: 3 }, {});
    const result = await runSimilarRepass(E, NOW);
    expect(result.scanned).toBe(0);
    expect(E.VECTORIZE.query).not.toHaveBeenCalled();
  });

  it('sob cap, nota com ZERO similar_edges tem prioridade sobre quem já tem', async () => {
    await seedNote('tem', NOW - 2 * H);
    await seedNote('zero', NOW - 1 * H);
    await seedNote('viz', NOW - 72 * H);
    await replaceSimilarEdges(E, 'tem', [{ to_id: 'viz', score: 0.6 }]);
    E.VECTORIZE = fakeVectorize(
      { tem: 1, zero: 2, viz: 3 },
      { 1: [{ id: 'viz', score: 0.65 }], 2: [{ id: 'viz', score: 0.7 }] }
    );
    const result = await runSimilarRepass(E, NOW, { limit: 1 });
    expect(result.refreshed).toBe(1);
    expect(result.completed).toBe(false);
    expect(await similarEdgeTargets('zero')).toEqual(['viz']); // a órfã foi a escolhida
  });

  it('falha do Vectorize numa nota não trava as demais', async () => {
    await seedNote('boom', NOW - 2 * H);
    await seedNote('ok', NOW - 1 * H);
    await seedNote('viz', NOW - 72 * H);
    E.VECTORIZE = fakeVectorize(
      { boom: 1, ok: 2, viz: 3 },
      { 2: [{ id: 'viz', score: 0.7 }] },
      { throwOnSig: 1 }
    );
    const result = await runSimilarRepass(E, NOW);
    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(await similarEdgeTargets('ok')).toEqual(['viz']);
  });

  it('nota sem vetor no índice conta em no_vector e é pulada (nunca re-embeda)', async () => {
    await seedNote('semvec', NOW - 1 * H);
    E.VECTORIZE = fakeVectorize({}, {}); // getByIds devolve vazio
    const result = await runSimilarRepass(E, NOW);
    expect(result.no_vector).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(E.VECTORIZE.query).not.toHaveBeenCalled();
  });

  it('watermark só avança quando a janela foi processada INTEIRA', async () => {
    await seedNote('a', NOW - 2 * H);
    await seedNote('b', NOW - 1 * H);
    await seedNote('viz', NOW - 72 * H);
    E.VECTORIZE = fakeVectorize(
      { a: 1, b: 2, viz: 3 },
      { 1: [{ id: 'viz', score: 0.7 }], 2: [{ id: 'viz', score: 0.7 }] }
    );
    // Cap atingido: watermark NÃO avança (próxima invocação re-varre; o
    // zero-edges-primeiro garante progresso sem cursor frágil)
    const capped = await runSimilarRepass(E, NOW, { limit: 1 });
    expect(capped.completed).toBe(false);
    expect(await E.GRAPH_CACHE.get(WATERMARK_KEY)).toBeNull();
    // Janela completa: watermark = nowMs
    const full = await runSimilarRepass(E, NOW);
    expect(full.completed).toBe(true);
    expect(Number(await E.GRAPH_CACHE.get(WATERMARK_KEY))).toBe(NOW);
  });
});
