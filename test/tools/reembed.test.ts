import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerReembed } from '../../src/mcp/tools/reembed.js';

const E = env as any;

describe('reembed', () => {
  beforeEach(async () => {
    E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.2)] })) };
    E.VECTORIZE = { upsert: vi.fn(async () => ({})), query: vi.fn() };
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(
      `INSERT INTO notes VALUES ('abc','Title','body','a tldr long enough','["biology"]','idea',1,1,null)`
    ).run();
  });

  function reg() {
    const r: any = {};
    registerReembed({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
    return r;
  }

  it('re-embeds an existing note and upserts the vector', async () => {
    const r = await reg().reembed({ id: 'abc' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.id).toBe('abc');
    expect(parsed.reembedded).toBe(true);
    expect(parsed.dimensions).toBe(1024);
    expect(E.AI.run).toHaveBeenCalledTimes(1);
    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown id', async () => {
    const r = await reg().reembed({ id: 'ghost' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
  });
});
