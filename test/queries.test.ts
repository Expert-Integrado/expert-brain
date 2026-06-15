import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertNote, insertEdge, insertTags,
  getNoteById, getTagsByNote, getEdgesFrom, ftsSearch,
  replaceSimilarEdges, getAllSimilarEdges,
} from '../src/db/queries.js';

const E = env as any;

describe('queries', () => {
  beforeAll(async () => { await runMigrations(E); });

  it('insert + read note', async () => {
    await insertNote(E, {
      id: 'n1', title: 'Red Queen', body: 'bod', tldr: 'coevolution forces running',
      domains: JSON.stringify(['cognitive-science']), kind: 'idea',
      created_at: 1, updated_at: 1,
    });
    const n = await getNoteById(E, 'n1');
    expect(n?.title).toBe('Red Queen');
  });

  it('tags', async () => {
    await insertTags(E, 'n1', ['a','b']);
    expect((await getTagsByNote(E,'n1')).sort()).toEqual(['a','b']);
  });

  it('edge uniqueness', async () => {
    await insertNote(E, {
      id:'n2',title:'Arms race',body:'',tldr:'x',
      domains:JSON.stringify(['leadership']),kind:null,created_at:1,updated_at:1,
    });
    await insertEdge(E, { id:'e1',from_id:'n1',to_id:'n2',relation_type:'analogous_to',why:'same coevolutionary pressure dynamic',created_at:1 });
    // Duplicate is silently ignored (INSERT OR IGNORE) so save_note partial-writes can't happen
    await insertEdge(E, { id:'e2',from_id:'n1',to_id:'n2',relation_type:'analogous_to',why:'same coevolutionary pressure dynamic',created_at:1 });
    expect((await getEdgesFrom(E,'n1')).length).toBe(1);
  });

  it('fts search', async () => {
    const r = await ftsSearch(E, 'coevolution', 10);
    expect(r.find((x) => x.id === 'n1')).toBeTruthy();
  });

  it('replaceSimilarEdges: write, overwrite and clear', async () => {
    // Notas dedicadas + filtro por from_id próprio: storage é COMPARTILHADO entre
    // arquivos de teste (isolatedStorage:false), então não dá pra assumir o estado
    // global de notes/similar_edges nem comparar a tabela inteira.
    for (const id of ['se_a', 'se_b']) {
      await insertNote(E, {
        id, title: id, body: '', tldr: 'x',
        domains: JSON.stringify(['music']), kind: null, created_at: 1, updated_at: 1,
      }).catch(() => { /* já existe nesta storage compartilhada */ });
    }
    const mineFrom = async (from: string) =>
      (await getAllSimilarEdges(E)).filter((s) => s.from_id === from);

    // grava o conjunto inicial de se_a
    await replaceSimilarEdges(E, 'se_a', [{ to_id: 'se_b', score: 0.81 }]);
    let mine = await mineFrom('se_a');
    expect(mine).toHaveLength(1);
    expect(mine[0].to_id).toBe('se_b');
    expect(mine[0].score).toBeCloseTo(0.81);

    // overwrite substitui (não acumula) — se_a continua com 1 edge
    await replaceSimilarEdges(E, 'se_a', [{ to_id: 'se_b', score: 0.95 }]);
    mine = await mineFrom('se_a');
    expect(mine).toHaveLength(1);
    expect(mine[0].score).toBeCloseTo(0.95);

    // conjunto vazio limpa as edges de se_a
    await replaceSimilarEdges(E, 'se_a', []);
    expect(await mineFrom('se_a')).toHaveLength(0);
  });
});
