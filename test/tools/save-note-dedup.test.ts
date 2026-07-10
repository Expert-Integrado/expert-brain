import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveNote } from '../../src/mcp/tools/save-note.js';
// Namespace import de propósito: as constantes novas (DEDUP_MIN_SCORE etc.) ainda
// não existem — via namespace o arquivo carrega e cada teste falha individualmente
// (red granular), em vez de derrubar a coleção inteira no import.
import * as similarity from '../../src/web/similarity.js';

// TDD da spec 70-grafo-higiene/71: gate SOFT de duplicatas no save_note.
// Escrito ANTES da implementação — red esperado até o PR1 entrar.

const E = env as any;
const OWNER_AUTH = { email: 'test@example.com', loggedInAt: 0 };
// PAT SEM escopo `private` (spec 31): keyId presente + scopes CSV sem 'private'.
const PAT_AUTH = { email: 'pat@example.com', loggedInAt: 0, keyId: 'key_test_pat', scopes: 'full' };

function fakeAI() {
  return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
}
function fakeVectorize() {
  return { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) };
}
function makeServer() {
  const registered: Record<string, any> = {};
  const server: any = {
    registerTool: (name: string, _meta: any, handler: any) => {
      registered[name] = handler;
    },
  };
  return { server, registered };
}
function payload(r: any): any {
  return JSON.parse(r.content[0].text);
}
async function seedNote(
  id: string, title: string, tldr: string, opts: { private?: boolean } = {}
): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`
  ).bind(id, title, 'corpo de teste', tldr, '["operations"]', 'concept', opts.private ? 1 : 0, 1000, 1000).run();
}

const BASE_INPUT = {
  body: 'corpo em markdown da nota de teste',
  domains: ['operations'],
  kind: 'concept' as const,
};

describe('save_note — gate soft de duplicatas (spec 71)', () => {
  beforeEach(async () => {
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM edges').run();
    await E.DB.prepare('DELETE FROM similar_edges').run();
    await E.DB.prepare('DELETE FROM tags').run();
    await E.DB.prepare('DELETE FROM notes').run();
  });

  it('exporta as bandas de score da similarity (fonte única)', () => {
    expect((similarity as any).DEDUP_MIN_SCORE).toBe(0.8);
    expect((similarity as any).LINK_SUGGESTION_MIN_SCORE).toBe(0.6);
  });

  it('match >= 0.80 vira possible_duplicates (hidratado) e NÃO bloqueia o save', async () => {
    await seedNote('dup-1', 'Gate soft de contexto', 'resumo da nota existente sobre gates');
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'dup-1', score: 0.86 }] }));
    const { server, registered } = makeServer();
    registerSaveNote(server, E, OWNER_AUTH);
    const r = await registered.save_note({
      ...BASE_INPUT,
      title: 'Gate soft de contexto em tools',
      tldr: 'resumo quase identico da nota sobre gates',
    });
    expect(r.isError).toBeUndefined();
    const p = payload(r);
    expect(Array.isArray(p.possible_duplicates)).toBe(true);
    expect(p.possible_duplicates).toHaveLength(1);
    expect(p.possible_duplicates[0].id).toBe('dup-1');
    expect(p.possible_duplicates[0].score).toBe(0.86);
    expect(p.possible_duplicates[0].title).toBe('Gate soft de contexto');
    expect(p.possible_duplicates[0].tldr).toContain('gates');
    // gate SOFT: a nota nova FOI salva mesmo assim
    const count = await E.DB.prepare('SELECT COUNT(*) AS n FROM notes').first();
    expect(count.n).toBe(2);
  });

  it('match 0.60-0.79 vira link_suggestions com tldr — não é duplicata', async () => {
    await seedNote('nb-1', 'Nota vizinha legitima', 'tldr da vizinha pra escrever o why');
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'nb-1', score: 0.72 }] }));
    const { server, registered } = makeServer();
    registerSaveNote(server, E, OWNER_AUTH);
    const r = await registered.save_note({
      ...BASE_INPUT,
      title: 'Nota nova com vizinhanca',
      tldr: 'conceito proximo mas distinto da vizinha',
    });
    expect(r.isError).toBeUndefined();
    const p = payload(r);
    expect(p.possible_duplicates).toEqual([]);
    expect(Array.isArray(p.link_suggestions)).toBe(true);
    expect(p.link_suggestions).toHaveLength(1);
    expect(p.link_suggestions[0].id).toBe('nb-1');
    expect(p.link_suggestions[0].score).toBe(0.72);
    // o tldr vai junto DE PROPÓSITO: é o insumo do why de mecanismo sem get_note extra
    expect(p.link_suggestions[0].tldr).toContain('why');
  });

  it('título quase idêntico pega duplicata via FTS mesmo com Vectorize vazio (dup intra-lote)', async () => {
    await seedNote('tit-1', 'Gate soft de duplicatas no save note', 'nota irma salva ha segundos');
    // Vectorize eventual-consistent: a irmã recém-salva ainda NÃO está no índice
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [] }));
    const { server, registered } = makeServer();
    registerSaveNote(server, E, OWNER_AUTH);
    const r = await registered.save_note({
      ...BASE_INPUT,
      title: 'Gate soft de duplicatas no save note',
      tldr: 'mesma tese salva de novo no mesmo lote',
    });
    expect(r.isError).toBeUndefined();
    const p = payload(r);
    const titleDups = (p.possible_duplicates ?? []).filter((d: any) => d.reason === 'title');
    expect(titleDups.map((d: any) => d.id)).toContain('tit-1');
    // sem métrica vetorial, o score do match de título é null honesto
    expect(titleDups[0].score).toBeNull();
  });

  it('dedupe_key repetida devolve a nota existente SEM re-embedar e SEM criar linha', async () => {
    const { server, registered } = makeServer();
    registerSaveNote(server, E, OWNER_AUTH);
    const first = await registered.save_note({
      ...BASE_INPUT,
      title: 'Item importado 001',
      tldr: 'primeiro save do item de import',
      dedupe_key: 'import-fonte-001',
    });
    expect(first.isError).toBeUndefined();
    const firstId = payload(first).id;
    const aiCallsAfterFirst = E.AI.run.mock.calls.length;

    const second = await registered.save_note({
      ...BASE_INPUT,
      title: 'Item importado 001 (re-run do lote)',
      tldr: 'segundo save do mesmo item de import',
      dedupe_key: 'import-fonte-001',
    });
    expect(second.isError).toBeUndefined();
    const p = payload(second);
    expect(p.deduped).toBe(true);
    expect(p.id).toBe(firstId);
    // gate HARD declarado: nem Workers AI nem insert rodam no hit
    expect(E.AI.run.mock.calls.length).toBe(aiCallsAfterFirst);
    const count = await E.DB.prepare('SELECT COUNT(*) AS n FROM notes').first();
    expect(count.n).toBe(1);
  });

  describe('telemetria do dedupe_key (spec 70-grafo-higiene/76)', () => {
    beforeEach(async () => {
      const today = new Date().toISOString().slice(0, 10);
      await E.GRAPH_CACHE.delete(`dedupe:hits:${today}`);
    });

    it('hit incrementa o contador diario dedupe:hits:<YYYY-MM-DD> em GRAPH_CACHE', async () => {
      const { server, registered } = makeServer();
      registerSaveNote(server, E, OWNER_AUTH);
      const today = new Date().toISOString().slice(0, 10);

      const first = await registered.save_note({
        ...BASE_INPUT,
        title: 'Item importado telemetria',
        tldr: 'primeiro save do item de telemetria',
        dedupe_key: 'import-telemetria-001',
      });
      expect(first.isError).toBeUndefined();
      expect(payload(first).deduped).toBeUndefined();
      // 1o save é o CRIADOR da chave — não é hit, contador segue ausente.
      expect(await E.GRAPH_CACHE.get(`dedupe:hits:${today}`)).toBeNull();

      const second = await registered.save_note({
        ...BASE_INPUT,
        title: 'Item importado telemetria (re-run)',
        tldr: 'segundo save do mesmo item de telemetria',
        dedupe_key: 'import-telemetria-001',
      });
      expect(payload(second).deduped).toBe(true);
      expect(await E.GRAPH_CACHE.get(`dedupe:hits:${today}`)).toBe('1');

      const third = await registered.save_note({
        ...BASE_INPUT,
        title: 'Item importado telemetria (re-run 2)',
        tldr: 'terceiro save do mesmo item de telemetria',
        dedupe_key: 'import-telemetria-001',
      });
      expect(payload(third).deduped).toBe(true);
      expect(await E.GRAPH_CACHE.get(`dedupe:hits:${today}`)).toBe('2');
    });

    it('falha do GRAPH_CACHE no hit do dedupe_key não derruba o save (best-effort)', async () => {
      const creator = makeServer();
      registerSaveNote(creator.server, E, OWNER_AUTH);
      const first = await creator.registered.save_note({
        ...BASE_INPUT,
        title: 'Item com kv quebrado',
        tldr: 'primeiro save antes da falha simulada de kv',
        dedupe_key: 'import-kv-quebrado',
      });
      expect(first.isError).toBeUndefined();

      const brokenEnv = {
        ...E,
        GRAPH_CACHE: {
          get: async () => { throw new Error('kv down'); },
          put: async () => { throw new Error('kv down'); },
        },
      };
      const hitter = makeServer();
      registerSaveNote(hitter.server, brokenEnv, OWNER_AUTH);
      const second = await hitter.registered.save_note({
        ...BASE_INPUT,
        title: 'Item com kv quebrado (re-run)',
        tldr: 'segundo save com o kv fora do ar',
        dedupe_key: 'import-kv-quebrado',
      });
      expect(second.isError).toBeUndefined();
      expect(payload(second).deduped).toBe(true);
    });
  });

  it('nota privada não vaza em possible_duplicates pra PAT sem escopo private; dono vê', async () => {
    await seedNote('priv-1', 'Nota privada sensivel', 'conteudo que nao pode vazar', { private: true });
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'priv-1', score: 0.9 }] }));

    const pat = makeServer();
    registerSaveNote(pat.server, E, PAT_AUTH);
    const rPat = await pat.registered.save_note({
      ...BASE_INPUT,
      title: 'Save via PAT sem escopo',
      tldr: 'tldr colidindo com a nota privada',
    });
    expect(rPat.isError).toBeUndefined();
    const pPat = payload(rPat);
    // o candidato privado SOME da lista (nunca aparece redigido)
    expect((pPat.possible_duplicates ?? []).map((d: any) => d.id)).not.toContain('priv-1');
    expect(pPat.possible_duplicates).toEqual([]);

    const owner = makeServer();
    registerSaveNote(owner.server, E, OWNER_AUTH);
    const rOwner = await owner.registered.save_note({
      ...BASE_INPUT,
      title: 'Save via sessao do dono',
      tldr: 'tldr colidindo com a nota privada de novo',
    });
    const pOwner = payload(rOwner);
    expect((pOwner.possible_duplicates ?? []).map((d: any) => d.id)).toContain('priv-1');
  });

  it('falha do Vectorize.query não derruba o save — listas vazias, nota salva', async () => {
    E.VECTORIZE.query = vi.fn(async () => {
      throw new Error('vectorize indisponivel');
    });
    const { server, registered } = makeServer();
    registerSaveNote(server, E, OWNER_AUTH);
    const r = await registered.save_note({
      ...BASE_INPUT,
      title: 'Save resiliente a falha de indice',
      tldr: 'nota salva mesmo com o indice fora do ar',
    });
    expect(r.isError).toBeUndefined();
    const p = payload(r);
    expect(p.possible_duplicates).toEqual([]);
    expect(p.link_suggestions).toEqual([]);
    const row = await E.DB.prepare('SELECT title FROM notes').first();
    expect(row.title).toBe('Save resiliente a falha de indice');
  });

  it('UMA consulta ao Vectorize alimenta dups, sugestões E as similar_edges persistidas', async () => {
    await seedNote('n1', 'Vizinha um', 'tldr da vizinha um');
    await seedNote('n2', 'Vizinha dois', 'tldr da vizinha dois');
    E.VECTORIZE.query = vi.fn(async () => ({
      matches: [{ id: 'n1', score: 0.7 }, { id: 'n2', score: 0.55 }],
    }));
    const { server, registered } = makeServer();
    registerSaveNote(server, E, OWNER_AUTH);
    const r = await registered.save_note({
      ...BASE_INPUT,
      title: 'Nota com vizinhanca dupla',
      tldr: 'nota que gera sugestao e similar edges',
    });
    expect(r.isError).toBeUndefined();
    const p = payload(r);
    // 0.7 entra em link_suggestions (>= 0.60); 0.55 não (mas entra nas similar_edges, >= 0.5)
    expect(p.link_suggestions.map((s: any) => s.id)).toEqual(['n1']);
    const edges = await E.DB.prepare(
      'SELECT to_id FROM similar_edges WHERE from_id = ? ORDER BY score DESC'
    ).bind(p.id).all();
    expect((edges.results ?? []).map((e: any) => e.to_id)).toEqual(['n1', 'n2']);
    // o refactor NÃO pode adicionar uma segunda chamada — dedup/sugestões/edges compartilham a consulta
    expect(E.VECTORIZE.query).toHaveBeenCalledTimes(1);
  });

  it('why genérico com 20+ chars é rejeitado (blocklist de mecanismo) e a nota NÃO salva', async () => {
    await seedNote('target-1', 'Nota alvo do edge', 'tldr da nota alvo');
    const { server, registered } = makeServer();
    registerSaveNote(server, E, OWNER_AUTH);
    const r = await registered.save_note({
      ...BASE_INPUT,
      title: 'Nota com why preguicoso',
      tldr: 'nota cujo edge tem why sem mecanismo',
      edges: [{
        to_id: 'target-1',
        relation_type: 'analogous_to',
        // 40+ chars, passa na régua de tamanho — mas é SÓ genérico
        why: 'essas notas sao relacionadas entre si e conectadas',
      }],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/mecanismo|mechanism/i);
    const count = await E.DB.prepare('SELECT COUNT(*) AS n FROM notes').first();
    expect(count.n).toBe(1); // só a seed — a nota do save rejeitado não entrou
  });
});
