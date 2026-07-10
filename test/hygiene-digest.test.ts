import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { insertEdge, replaceSimilarEdges } from '../src/db/queries.js';
// TDD da spec 70-grafo-higiene/73 — o módulo ainda NÃO existe: este import falha
// inteiro até o PR3 entrar (red de coleção, esperado).
import { buildHygieneDigest, shouldSendHygieneDigest, HYGIENE_MAX_CHARS } from '../src/digest/hygiene.js';

const E = env as any;
const DAY = 86_400_000;
// 06/07/2026 é segunda-feira; 11:00 UTC = horário do cron diário
const MONDAY = Date.UTC(2026, 6, 6, 11, 0, 0);
const TUESDAY = Date.UTC(2026, 6, 7, 11, 0, 0);

async function seedNote(
  id: string, title: string, createdAt: number,
  opts: { kind?: string; createdBy?: string | null } = {}
): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at,created_by)
     VALUES (?,?,?,?,?,?,?,?,NULL,?)`
  ).bind(
    id, title, 'corpo', `tldr da ${id}`, '["operations"]',
    opts.kind ?? 'concept', createdAt, createdAt, opts.createdBy ?? null
  ).run();
}

async function seedEdge(from: string, to: string, why: string, createdAt: number): Promise<void> {
  await insertEdge(E, {
    id: `edge-${from}-${to}`,
    from_id: from,
    to_id: to,
    relation_type: 'analogous_to',
    why,
    created_at: createdAt,
  });
}

const GOOD_WHY = 'ambos os sistemas compartilham feedback negativo atrasado que gera oscilacao';

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await E.DB.prepare('DELETE FROM edges').run();
  await E.DB.prepare('DELETE FROM similar_edges').run();
  await E.DB.prepare('DELETE FROM notes').run();
});

describe('shouldSendHygieneDigest (spec 73)', () => {
  it('true só no cron diário em segunda-feira UTC', () => {
    expect(shouldSendHygieneDigest('0 11 * * *', MONDAY)).toBe(true);
    expect(shouldSendHygieneDigest('0 11 * * *', TUESDAY)).toBe(false);
    expect(shouldSendHygieneDigest('0 5 * * 1', MONDAY)).toBe(false); // cron do backup
    expect(shouldSendHygieneDigest('0 8 * * *', MONDAY)).toBe(false); // cron do re-pass
  });
});

describe('buildHygieneDigest (spec 73)', () => {
  it('conta e titula as órfãs da semana; nota com edge real não é órfã', async () => {
    await seedNote('o1', 'Titulo orfa um', MONDAY - 2 * DAY);
    await seedNote('o2', 'Titulo orfa dois', MONDAY - 3 * DAY);
    await seedNote('c1', 'Conectada um', MONDAY - 2 * DAY);
    await seedNote('c2', 'Conectada dois', MONDAY - 2 * DAY);
    await seedEdge('c1', 'c2', GOOD_WHY, MONDAY - 2 * DAY);
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text).toContain('Titulo orfa um');
    expect(text).toContain('Titulo orfa dois');
    expect(text).not.toContain('Conectada um');
  });

  it('nota órfã ANTIGA (fora da janela de 7 dias) não entra', async () => {
    await seedNote('velha', 'Orfa antiga fora da janela', MONDAY - 30 * DAY);
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text).not.toContain('Orfa antiga fora da janela');
  });

  it('par >= 0.80 sem edge real aparece UMA vez (dedupe simétrico A-B/B-A)', async () => {
    await seedNote('p1', 'Nota par alfa', MONDAY - 2 * DAY);
    await seedNote('p2', 'Nota par beta', MONDAY - 2 * DAY);
    // âncoras pra p1/p2 não caírem na seção de órfãs (edge real com terceiros)
    await seedNote('q1', 'Ancora um', MONDAY - 2 * DAY);
    await seedNote('q2', 'Ancora dois', MONDAY - 2 * DAY);
    await seedEdge('p1', 'q1', GOOD_WHY, MONDAY - 2 * DAY);
    await seedEdge('p2', 'q2', GOOD_WHY, MONDAY - 2 * DAY);
    // similar_edges nas DUAS direções — o digest deduplica pela chave simétrica
    await replaceSimilarEdges(E, 'p1', [{ to_id: 'p2', score: 0.86 }]);
    await replaceSimilarEdges(E, 'p2', [{ to_id: 'p1', score: 0.86 }]);
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text.split('Nota par alfa').length - 1).toBe(1);
    expect(text).toContain('Nota par beta');
  });

  it('par >= 0.80 COM edge real entre si não é suspeito', async () => {
    await seedNote('r1', 'Nota resolvida um', MONDAY - 2 * DAY);
    await seedNote('r2', 'Nota resolvida dois', MONDAY - 2 * DAY);
    await seedEdge('r1', 'r2', GOOD_WHY, MONDAY - 2 * DAY);
    await replaceSimilarEdges(E, 'r1', [{ to_id: 'r2', score: 0.9 }]);
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text).not.toContain('Nota resolvida um');
  });

  it('volume por conta: agrupa por created_by, NULL é a sessão do dono', async () => {
    await seedNote('v1', 'Volume um', MONDAY - 1 * DAY, { createdBy: 'key_conta_x' });
    await seedNote('v2', 'Volume dois', MONDAY - 1 * DAY, { createdBy: 'key_conta_x' });
    await seedNote('v3', 'Volume tres', MONDAY - 1 * DAY, { createdBy: null });
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text).toContain('key_conta_x');
    expect(text).toMatch(/dono/i);
  });

  it('edge da semana com why < 30 chars entra na seção de whys preguiçosos', async () => {
    await seedNote('w1', 'Why um', MONDAY - 2 * DAY);
    await seedNote('w2', 'Why dois', MONDAY - 2 * DAY);
    await seedEdge('w1', 'w2', 'mecanismo raso xy', MONDAY - 1 * DAY); // 17 chars
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text).toContain('mecanismo raso xy');
  });

  it('nunca excede HYGIENE_MAX_CHARS (mensagem própria, teto Telegram com folga)', async () => {
    expect(HYGIENE_MAX_CHARS).toBe(1200);
    for (let i = 0; i < 60; i++) {
      await seedNote(
        `bulk-${i}`,
        `Nota orfa de carga numero ${i} com titulo comprido de proposito pra estourar`,
        MONDAY - 1 * DAY
      );
    }
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text.length).toBeLessThanOrEqual(HYGIENE_MAX_CHARS);
  });

  it('semana limpa gera mensagem curta de saúde, não string vazia', async () => {
    const text = await buildHygieneDigest(E, MONDAY);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(200);
  });
});
