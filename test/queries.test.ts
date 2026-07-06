import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertNote, insertEdge, insertTags,
  getNoteById, getTagsByNote, getEdgesFrom, ftsSearch,
  replaceSimilarEdges, getAllSimilarEdges, updateNote,
  listDomainCounts, insertTask,
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

  describe('updateNote — concorrência otimista (spec 36 fase 2)', () => {
    it('sem expectedUpdatedAt: last-write-wins, retorna "ok"', async () => {
      await insertNote(E, {
        id: 'un1', title: 'orig', body: 'b', tldr: 'tldr aqui original',
        domains: JSON.stringify(['operations']), kind: 'concept', created_at: 1, updated_at: 1000,
      });
      const r = await updateNote(E, 'un1', { title: 'novo', updated_at: 2000 });
      expect(r).toBe('ok');
      const n = await getNoteById(E, 'un1');
      expect(n?.title).toBe('novo');
      expect(n?.updated_at).toBe(2000);
    });

    it('expectedUpdatedAt bate: grava e retorna "ok"', async () => {
      await insertNote(E, {
        id: 'un2', title: 'orig', body: 'b', tldr: 'tldr aqui original',
        domains: JSON.stringify(['operations']), kind: 'concept', created_at: 1, updated_at: 1000,
      });
      const r = await updateNote(E, 'un2', { title: 'novo', updated_at: 2000 }, 1000);
      expect(r).toBe('ok');
      expect((await getNoteById(E, 'un2'))?.title).toBe('novo');
    });

    it('expectedUpdatedAt defasado: retorna "conflict" e NÃO grava', async () => {
      await insertNote(E, {
        id: 'un3', title: 'orig', body: 'b', tldr: 'tldr aqui original',
        domains: JSON.stringify(['operations']), kind: 'concept', created_at: 1, updated_at: 1000,
      });
      // Algo já avançou o updated_at pra 1500.
      await updateNote(E, 'un3', { updated_at: 1500 });
      const r = await updateNote(E, 'un3', { title: 'tarde demais', updated_at: 2000 }, 1000);
      expect(r).toBe('conflict');
      const n = await getNoteById(E, 'un3');
      expect(n?.title).toBe('orig'); // não sobrescreveu
      expect(n?.updated_at).toBe(1500);
    });
  });

  // spec 54 — contagem por área pra seção "Áreas e tipos" de /app/config. Storage
  // é COMPARTILHADO entre arquivos de teste (isolatedStorage:false — ver comentário
  // acima em replaceSimilarEdges), então usamos slugs BEM distintivos e checamos só
  // as chaves nossas no mapa retornado, nunca o mapa inteiro.
  describe('listDomainCounts (spec 54 — isolamento de task)', () => {
    it('conta notas de CONHECIMENTO por área, somando entradas repetidas', async () => {
      await insertNote(E, {
        id: 'dc1', title: 'dc1', body: '', tldr: 'x',
        domains: JSON.stringify(['dominio-contagem-x']), kind: 'concept', created_at: 1, updated_at: 1,
      });
      await insertNote(E, {
        id: 'dc2', title: 'dc2', body: '', tldr: 'x',
        domains: JSON.stringify(['dominio-contagem-x', 'dominio-contagem-y']), kind: 'concept', created_at: 1, updated_at: 1,
      });
      const counts = await listDomainCounts(E);
      expect(counts['dominio-contagem-x']).toBe(2);
      expect(counts['dominio-contagem-y']).toBe(1);
    });

    it('task NUNCA entra na contagem, mesmo usando o mesmo slug de uma nota', async () => {
      await insertNote(E, {
        id: 'dc3', title: 'dc3', body: '', tldr: 'x',
        domains: JSON.stringify(['dominio-contagem-task']), kind: 'concept', created_at: 1, updated_at: 1,
      });
      await insertTask(E, {
        id: 'dctask1', title: 'Task dc', body: 'b', tldr: 'Task dc aqui',
        domains: JSON.stringify(['dominio-contagem-task']),
        status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1,
      });
      const counts = await listDomainCounts(E);
      // Só a nota conta — a task com o MESMO slug não soma 2.
      expect(counts['dominio-contagem-task']).toBe(1);
    });

    it('domínio usado só por uma task (nenhuma nota) não aparece no mapa', async () => {
      await insertTask(E, {
        id: 'dctask2', title: 'Task só', body: 'b', tldr: 'Task so aqui',
        domains: JSON.stringify(['dominio-so-task']),
        status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1,
      });
      const counts = await listDomainCounts(E);
      expect(counts['dominio-so-task']).toBeUndefined();
    });
  });
});
