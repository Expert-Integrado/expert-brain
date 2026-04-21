import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerRecall } from '../../src/mcp/tools/recall.js';

const E = env as any;

async function seed() {
  const rows: Array<[string,string,string,string]> = [
    ['a','Red Queen','coevolution forces running','["evolutionary-biology"]'],
    ['b','Arms race','military escalation loop','["military-history"]'],
    ['c','Tech debt spiral','compounding code rot','["software-engineering"]'],
    ['d','Predator-prey','population oscillation','["evolutionary-biology"]'],
    ['e','Moloch','multi-party race to bottom','["game-theory"]'],
  ];
  for (const [id,t,tl,dom] of rows) {
    await E.DB.prepare(
      `INSERT INTO notes VALUES (?,?,?,?,?,null,0,0)`
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
    expect(r.content[0].text).toContain('evolutionary-biology');
  });

  it('accepts valid domains_filter slug', async () => {
    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'coevolution', domains_filter: ['evolutionary-biology'] });
    expect(r.isError).toBeUndefined();
  });

  it('domains_filter matches any domain on the note, not just primary', async () => {
    // Seed one extra note where evolutionary-biology is the SECONDARY domain.
    await E.DB.prepare(
      `INSERT INTO notes VALUES (?,?,?,?,?,null,0,0)`
    ).bind('f', 'Secondary evo', 'b', 'selection as feedback', '["systems-thinking","evolutionary-biology"]').run();
    // Mock vector match to surface the new note.
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'f', score: 0.95 }] }));

    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'feedback', domains_filter: ['evolutionary-biology'] });
    const parsed = JSON.parse(r.content[0].text);
    // Note 'f' has evolutionary-biology as the SECOND domain. Old code would
    // drop it (primary is systems-thinking); fixed code keeps it.
    const ids = parsed.results.map((x: any) => x.id);
    expect(ids).toContain('f');
  });

  it('response does not leak internal allDomains field', async () => {
    const registered: any = {};
    const server: any = { registerTool: (n: string, _m: any, h: any) => { registered[n] = h; } };
    registerRecall(server, E);
    const r = await registered.recall({ query: 'coevolution' });
    const parsed = JSON.parse(r.content[0].text);
    for (const hit of parsed.results) {
      expect(hit.allDomains).toBeUndefined();
      expect(Object.keys(hit).sort()).toEqual(['domain', 'id', 'kind', 'title', 'tldr']);
    }
  });
});
