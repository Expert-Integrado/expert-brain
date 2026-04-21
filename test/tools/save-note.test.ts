import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveNote } from '../../src/mcp/tools/save-note.js';

const E = env as any;

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

describe('save_note', () => {
  beforeEach(async () => {
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM edges').run();
    await E.DB.prepare('DELETE FROM tags').run();
    await E.DB.prepare('DELETE FROM notes').run();
  });

  it('saves a note and embeds the tldr', async () => {
    const { server, registered } = makeServer();
    registerSaveNote(server, E);
    const r = await registered.save_note({
      title: 'Red Queen',
      body: 'bod',
      tldr: 'coevolution forces constant running just to keep place',
      domains: ['evolutionary-biology'],
      kind: 'concept',
    });
    expect(r.isError).toBeUndefined();
    expect(E.AI.run).toHaveBeenCalled();
    expect(E.VECTORIZE.upsert).toHaveBeenCalled();
    const row = await E.DB.prepare('SELECT * FROM notes').first();
    expect(row.title).toBe('Red Queen');
    expect(row.kind).toBe('concept');
  });

  it('rejects edge why shorter than 20 chars', async () => {
    const { server, registered } = makeServer();
    registerSaveNote(server, E);
    await E.DB.prepare(
      `INSERT INTO notes VALUES ('target','t','b','tl','["seed-domain"]',null,0,0)`
    ).run();
    const r = await registered.save_note({
      title: 'X',
      body: 'b',
      tldr: 'tl of at least ten chars here ok',
      domains: ['seed-domain'],
      kind: 'concept',
      edges: [{ to_id: 'target', relation_type: 'analogous_to', why: 'too short' }],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('20 characters');
  });

  it('rejects edge pointing to missing note', async () => {
    const { server, registered } = makeServer();
    registerSaveNote(server, E);
    const r = await registered.save_note({
      title: 'X', body: 'b',
      tldr: 'tldr long enough here really',
      domains: ['seed-domain'],
      kind: 'concept',
      edges: [{ to_id: 'ghost', relation_type: 'analogous_to', why: 'this is a long enough why to pass validation' }],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
  });

  it('rejects uppercase domain', async () => {
    const { server, registered } = makeServer();
    registerSaveNote(server, E);
    const r = await registered.save_note({
      title: 'X', body: 'b',
      tldr: 'tldr long enough here really',
      domains: ['Evolutionary-Biology'],
      kind: 'concept',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Evolutionary-Biology');
  });

  it('rejects accented domain', async () => {
    const { server, registered } = makeServer();
    registerSaveNote(server, E);
    const r = await registered.save_note({
      title: 'X', body: 'b',
      tldr: 'tldr long enough here really',
      domains: ['biologia-evolutiva-avançada'],
      kind: 'concept',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('biologia-evolutiva-avançada');
  });

  it('does not write to D1 when domain validation fails', async () => {
    const { server, registered } = makeServer();
    registerSaveNote(server, E);
    await registered.save_note({
      title: 'X', body: 'b',
      tldr: 'tldr long enough here really',
      domains: ['INVALID'],
      kind: 'concept',
    });
    const count = await E.DB.prepare('SELECT count(*) c FROM notes').first();
    expect(count.c).toBe(0);
  });
});
