import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertNote, getNoteById } from '../../src/db/queries.js';
import { reembedNoteIfNeeded } from '../../src/db/note-write.js';
import { SIMILARITY_TOP_K } from '../../src/web/similarity.js';

// TDD da spec 70-grafo-higiene/76: reembedNoteIfNeeded passa de Promise<boolean>
// pra Promise<{ reembedded, matches }> — a MESMA consulta de vizinhança que
// persiste as similar_edges agora também alimenta o possible_duplicates do
// caller MCP (update_note), sem uma segunda chamada ao Vectorize.

const E = env as any;

function fakeAI(value = 0.2) {
  return { run: vi.fn(async () => ({ data: [Array(1024).fill(value)] })) };
}
function fakeVectorize(matches: Array<{ id: string; score: number }> = []) {
  return {
    upsert: vi.fn(async () => ({})),
    query: vi.fn(async () => ({ matches })),
  };
}

async function seed(id: string, tldr: string, domains = '["operations"]', kind: string | null = 'concept'): Promise<void> {
  await insertNote(E, {
    id, title: `Nota ${id}`, body: 'corpo de teste', tldr, domains, kind,
    created_at: 1000, updated_at: 1000,
  });
}

describe('reembedNoteIfNeeded — retorno { reembedded, matches } (spec 70-grafo-higiene/76)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM similar_edges').run();
    await E.DB.prepare('DELETE FROM tags').run();
    await E.DB.prepare('DELETE FROM edges').run();
    await E.DB.prepare('DELETE FROM notes').run();
    E.AI = fakeAI();
  });

  it('nada semântico mudou: não reembeda, matches vazio, Workers AI e Vectorize NÃO são chamados', async () => {
    await seed('abc', 'tldr original suficiente aqui');
    E.VECTORIZE = fakeVectorize();
    const existing = await getNoteById(E, 'abc');
    const result = await reembedNoteIfNeeded(E, existing!, { title: 'Novo título' });
    expect(result).toEqual({ reembedded: false, matches: [] });
    expect(E.AI.run).not.toHaveBeenCalled();
    expect(E.VECTORIZE.query).not.toHaveBeenCalled();
  });

  it('tldr mudou: reembeda, consulta SIMILARITY_TOP_K+2 e persiste as similar edges com os matches devolvidos', async () => {
    await seed('abc', 'tldr original suficiente aqui');
    await seed('viz1', 'tldr de uma vizinha suficiente aqui');
    await seed('viz2', 'tldr de outra vizinha suficiente aqui');
    E.VECTORIZE = fakeVectorize([{ id: 'viz1', score: 0.7 }, { id: 'viz2', score: 0.55 }]);
    const existing = await getNoteById(E, 'abc');
    const result = await reembedNoteIfNeeded(E, existing!, { tldr: 'um tldr novo bem diferente de tudo' });
    expect(result.reembedded).toBe(true);
    expect(result.matches).toEqual([{ id: 'viz1', score: 0.7 }, { id: 'viz2', score: 0.55 }]);
    expect(E.VECTORIZE.query).toHaveBeenCalledTimes(1);
    expect(E.VECTORIZE.query.mock.calls[0][1].topK).toBe(SIMILARITY_TOP_K + 2);
    const rows = await E.DB.prepare(
      'SELECT to_id FROM similar_edges WHERE from_id = ? ORDER BY score DESC'
    ).bind('abc').all();
    expect((rows.results ?? []).map((r: any) => r.to_id)).toEqual(['viz1', 'viz2']);
    // refreshSimilarEdges (que faria UMA SEGUNDA query) sai desse caminho — só 1 chamada.
    expect(E.VECTORIZE.query).toHaveBeenCalledTimes(1);
  });

  it('domains mudando também reembeda e consulta a vizinhança', async () => {
    await seed('abc', 'tldr original suficiente aqui', '["operations"]', 'concept');
    E.VECTORIZE = fakeVectorize([]);
    const existing = await getNoteById(E, 'abc');
    const result = await reembedNoteIfNeeded(E, existing!, { domains: ['product'] });
    expect(result.reembedded).toBe(true);
    expect(result.matches).toEqual([]);
    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it('kind mudando também reembeda, mesmo com kind legado null', async () => {
    await seed('legacy', 'tldr de nota legada suficiente aqui', '["operations"]', null);
    E.VECTORIZE = fakeVectorize([]);
    const existing = await getNoteById(E, 'legacy');
    const result = await reembedNoteIfNeeded(E, existing!, { kind: 'principle' as any });
    expect(result.reembedded).toBe(true);
    expect(E.VECTORIZE.upsert.mock.calls[0][0][0].metadata.kind).toBe('principle');
  });

  it('falha na consulta ao Vectorize: matches vazio, reembedded continua true (best-effort, edges ficam pro re-pass)', async () => {
    await seed('abc', 'tldr original suficiente aqui');
    E.VECTORIZE = {
      upsert: vi.fn(async () => ({})),
      query: vi.fn(async () => { throw new Error('vectorize indisponível'); }),
    };
    const existing = await getNoteById(E, 'abc');
    const result = await reembedNoteIfNeeded(E, existing!, { tldr: 'outro tldr novo bem diferente de tudo' });
    expect(result.reembedded).toBe(true);
    expect(result.matches).toEqual([]);
    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1); // embed/upsert já rodaram antes da consulta falhar
  });
});
