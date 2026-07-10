import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerRecall } from '../../src/mcp/tools/recall.js';

const E = env as any;

async function seed() {
  const rows: Array<[string,string,string,string]> = [
    ['a','Red Queen','coevolution forces running','["cognitive-science"]'],
    ['b','Arms race','military escalation loop','["military-history"]'],
    ['c','Tech debt spiral','compounding code rot','["software-engineering"]'],
    ['d','Predator-prey','population oscillation','["cognitive-science"]'],
    ['e','Moloch','multi-party race to bottom','["game-theory"]'],
  ];
  for (const [id,t,tl,dom] of rows) {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,null,0,0,null)`
    ).bind(id,t,'body',tl,dom).run();
  }
}

describe('recall', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
    E.VECTORIZE = {
      upsert: vi.fn(),
      query: vi.fn(async () => ({ matches: [
        { id: 'a', score: 0.9 }, { id: 'b', score: 0.85 },
        { id: 'c', score: 0.8 }, { id: 'e', score: 0.75 }, { id: 'd', score: 0.7 },
      ] })),
    };
    await seed();
  });

  it('returns domain-balanced results without body', async () => {
    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'coevolution', limit: 15 });
    const parsed = JSON.parse(r.content[0].text);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    for (const x of parsed.results) {
      expect(x.body).toBeUndefined();
      expect(x.tldr).toBeDefined();
    }
    const domains = new Set(parsed.results.map((x: any) => x.domain));
    expect(domains.size).toBeGreaterThanOrEqual(2);
  });

  it('rejects invalid domains_filter slug', async () => {
    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'x', domains_filter: ['INVALID'] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('INVALID');
    // The validator's error message references 'evolutionary-biology' as the
    // canonical example for translating non-English slugs — that's the example,
    // not the project's actual canonical domain. Keeping the assertion stable.
    expect(r.content[0].text).toContain('evolutionary-biology');
  });

  it('accepts valid domains_filter slug', async () => {
    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'coevolution', domains_filter: ['cognitive-science'] });
    expect(r.isError).toBeUndefined();
  });

  it('domains_filter matches any domain on the note, not just primary', async () => {
    // Seed one extra note where evolutionary-biology is the SECONDARY domain.
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,null,0,0,null)`
    ).bind('f', 'Secondary evo', 'b', 'selection as feedback', '["systems-thinking","cognitive-science"]').run();
    // Mock vector match to surface the new note.
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'f', score: 0.95 }] }));

    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'feedback', domains_filter: ['cognitive-science'] });
    const parsed = JSON.parse(r.content[0].text);
    // Note 'f' has evolutionary-biology as the SECOND domain. Old code would
    // drop it (primary is systems-thinking); fixed code keeps it.
    const ids = parsed.results.map((x: any) => x.id);
    expect(ids).toContain('f');
  });

  it('domains_filter pulls notes into the pool even when not matched by query', async () => {
    // Add a note in evolutionary-biology whose tldr has nothing to do with the
    // query. Mock vector + FTS to return ZERO matches for this note — it only
    // enters the pool via the domain filter retrieval.
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,null,0,0,null)`
    ).bind('g', 'Cambrian explosion', 'b', 'rapid diversification of body plans', '["cognitive-science"]').run();
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [] })); // no semantic match

    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({
      query: 'completely unrelated query that matches nothing',
      domains_filter: ['cognitive-science'],
    });
    const parsed = JSON.parse(r.content[0].text);
    const ids = parsed.results.map((x: any) => x.id);
    // Without the domain retrieval, pool would be empty → results []. With it,
    // all evolutionary-biology notes (a, d, g from this suite) are pulled in.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('g');
  });

  it('domains_filter never returns a task (kind=task leak fix)', async () => {
    // Seed a task in cognitive-science (same domain as knowledge notes a/d).
    // Task has domains, so the domain retrieval would pull it in; NON_TASK_FILTER
    // must drop it in both the retrieval and the hydration.
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at,status,due_at,priority,completed_at)
       VALUES ('task-leak','Do a thing','b','tl','["cognitive-science"]','task',0,0,null,'open',null,null,null)`
    ).run();
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [] }));

    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'x', domains_filter: ['cognitive-science'] });
    const parsed = JSON.parse(r.content[0].text);
    const ids = parsed.results.map((x: any) => x.id);
    expect(ids).not.toContain('task-leak');
    // The knowledge notes of the same domain ARE present (a, d).
    expect(ids).toContain('a');
    expect(ids).toContain('d');
  });

  it('domains_filter with a pool > 100 ids does not blow up (chunked hydration)', async () => {
    // Seed 120 extra notes in a single domain. With LIMIT 200 on the domain
    // retrieval the pool passes 100 ids — the single IN(...) would have hit the
    // D1 bind cap; the chunked getNotesByIds keeps it safe.
    const stmt = E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,null,?,?,null)`
    );
    const batch = [];
    for (let i = 0; i < 120; i++) {
      batch.push(stmt.bind(`big${i}`, `Big ${i}`, 'body', `tldr ${i}`, '["operations"]', i, i));
    }
    await E.DB.batch(batch);
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [] }));

    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'anything', domains_filter: ['operations'], limit: 30 });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it('domains_filter paginates via offset with disjoint pages and no 3-per-domain cap', async () => {
    // Seed 40 notes, all with operations as the PRIMARY domain. The old balancer
    // would cap operations at 3; with a filter it must be relaxed and offset must
    // page through all of them.
    const stmt = E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,null,?,?,null)`
    );
    const batch = [];
    for (let i = 0; i < 40; i++) {
      // updated_at descending id order: newer i => higher updated_at
      batch.push(stmt.bind(`p${String(i).padStart(2, '0')}`, `P ${i}`, 'body', `tldr ${i}`, '["operations"]', i, i));
    }
    await E.DB.batch(batch);
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [] }));

    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);

    const page0 = JSON.parse((await registered.recall({ query: 'anything', domains_filter: ['operations'], limit: 5, offset: 0 })).content[0].text);
    const page1 = JSON.parse((await registered.recall({ query: 'anything', domains_filter: ['operations'], limit: 5, offset: 5 })).content[0].text);
    const ids0 = page0.results.map((x: any) => x.id);
    const ids1 = page1.results.map((x: any) => x.id);
    expect(ids0.length).toBe(5);
    expect(ids1.length).toBe(5);
    // pages disjoint
    for (const id of ids0) expect(ids1).not.toContain(id);
    // cap relaxed: iterate all pages and count total operations notes enumerated
    const seen = new Set<string>();
    for (let off = 0; off < 60; off += 10) {
      const pg = JSON.parse((await registered.recall({ query: 'anything', domains_filter: ['operations'], limit: 10, offset: off })).content[0].text);
      for (const x of pg.results) seen.add(x.id);
      if (pg.results.length < 10) break;
    }
    // Well above the old ~3-per-primary-domain ceiling of 15.
    expect(seen.size).toBeGreaterThan(15);
  });

  it('response does not leak internal allDomains field', async () => {
    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'coevolution' });
    const parsed = JSON.parse(r.content[0].text);
    for (const hit of parsed.results) {
      // O essencial: allDomains (campo interno de filtro) NÃO pode vazar.
      expect(hit.allDomains).toBeUndefined();
      // url é intencional (link clicável da nota, como o save_note) — faz parte do shape
      // externo. score idem (spec 70-grafo-higiene/74: cosseno do vetor, null em FTS/domínio).
      expect(Object.keys(hit).sort()).toEqual(['domain', 'id', 'kind', 'score', 'title', 'tldr', 'url']);
    }
  });
});
