import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveNote } from '../../src/mcp/tools/save-note.js';
import { registerRecall } from '../../src/mcp/tools/recall.js';

// TDD da spec 70-grafo-higiene/74: recall expõe o score de similaridade.
// Escrito ANTES da implementação — red esperado até o PR4 entrar.

const E = env as any;
const AUTH = { email: 'test@example.com', loggedInAt: 0 };

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

describe('recall — score de similaridade (spec 74)', () => {
  let idVec: string;
  let idFts: string;

  beforeEach(async () => {
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM edges').run();
    await E.DB.prepare('DELETE FROM similar_edges').run();
    await E.DB.prepare('DELETE FROM tags').run();
    await E.DB.prepare('DELETE FROM notes').run();

    const { server, registered } = makeServer();
    registerSaveNote(server, E, AUTH);
    const a = await registered.save_note({
      title: 'Nota vetorial de referencia',
      body: 'corpo da nota vetorial',
      tldr: 'conceito que o indice vetorial conhece bem',
      domains: ['operations'],
      kind: 'concept',
    });
    idVec = payload(a).id;
    const b = await registered.save_note({
      title: 'Nota xyzzykeyword de texto',
      body: 'corpo da nota de texto',
      tldr: 'conceito achavel so por xyzzykeyword no fts',
      domains: ['sales'],
      kind: 'concept',
    });
    idFts = payload(b).id;
  });

  it('hit do vetor traz score numérico; hit só de FTS traz score null', async () => {
    // O Vectorize devolve SÓ a nota vetorial; a outra entra no pool via FTS
    // (token único xyzzykeyword) — as duas origens precisam ser distinguíveis.
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: idVec, score: 0.83 }] }));
    const { server, registered } = makeServer();
    registerRecall(server, E, AUTH);
    const r = await registered.recall({ query: 'xyzzykeyword vetorial' });
    expect(r.isError).toBeUndefined();
    const results = payload(r).results;
    const hitVec = results.find((h: any) => h.id === idVec);
    const hitFts = results.find((h: any) => h.id === idFts);
    expect(hitVec).toBeDefined();
    expect(hitFts).toBeDefined();
    expect(hitVec.score).toBe(0.83);
    // rank de FTS5 não é comparável a cosseno — null honesto, não número inventado
    expect(hitFts).toHaveProperty('score', null);
  });

  it('hit injetado por domains_filter (sem match semântico/keyword) traz score null', async () => {
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [] }));
    const { server, registered } = makeServer();
    registerRecall(server, E, AUTH);
    // query sem nenhum token das notas: o hit de 'sales' entra SÓ pelo retrieval
    // por domínio (domains_filter puxa o domínio inteiro pro pool)
    const r = await registered.recall({ query: 'qqqzz wwwvv', domains_filter: ['sales'] });
    expect(r.isError).toBeUndefined();
    const results = payload(r).results;
    const injected = results.find((h: any) => h.id === idFts);
    expect(injected).toBeDefined();
    expect(injected).toHaveProperty('score', null);
  });

  it('o mesmo id duplicado no retorno do Vectorize fica com o MAIOR score', async () => {
    E.VECTORIZE.query = vi.fn(async () => ({
      matches: [
        { id: idVec, score: 0.61 },
        { id: idVec, score: 0.79 },
      ],
    }));
    const { server, registered } = makeServer();
    registerRecall(server, E, AUTH);
    const r = await registered.recall({ query: 'vetorial referencia' });
    const hit = payload(r).results.find((h: any) => h.id === idVec);
    expect(hit.score).toBe(0.79);
  });
});
