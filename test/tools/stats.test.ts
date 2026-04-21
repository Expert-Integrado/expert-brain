import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerStats } from '../../src/mcp/tools/stats.js';

const E = env as any;

async function resetDb(): Promise<void> {
  await E.DB.prepare('DELETE FROM edges').run();
  await E.DB.prepare('DELETE FROM tags').run();
  await E.DB.prepare('DELETE FROM notes').run();
}

async function seed(
  id: string, domains: string[], kind: string, createdAt: number
): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, 't', 'b', 'a tldr long enough', JSON.stringify(domains), kind, createdAt, createdAt).run();
}

function reg() {
  const r: any = {};
  registerStats({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
  return r;
}

describe('stats', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await resetDb();
  });

  it('returns zero counts for empty vault', async () => {
    const r = await reg().stats({});
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.total_notes).toBe(0);
    expect(parsed.total_edges).toBe(0);
    expect(parsed.notes_by_domain).toEqual([]);
    expect(parsed.notes_by_kind).toEqual([]);
    expect(parsed.recent_7d).toBe(0);
    expect(parsed.recent_30d).toBe(0);
  });

  it('counts by domain expanding multi-domain notes', async () => {
    const now = Date.now();
    await seed('a', ['biology'], 'concept', now);
    await seed('b', ['biology', 'economics'], 'insight', now);
    await seed('c', ['economics'], 'concept', now);

    const r = await reg().stats({});
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.total_notes).toBe(3);
    const byDomain = new Map(parsed.notes_by_domain.map((d: any) => [d.domain, d.count]));
    expect(byDomain.get('biology')).toBe(2);
    expect(byDomain.get('economics')).toBe(2);
  });

  it('groups by kind', async () => {
    const now = Date.now();
    await seed('a', ['biology'], 'concept', now);
    await seed('b', ['biology'], 'concept', now);
    await seed('c', ['biology'], 'insight', now);

    const r = await reg().stats({});
    const parsed = JSON.parse(r.content[0].text);
    const byKind = new Map(parsed.notes_by_kind.map((k: any) => [k.kind, k.count]));
    expect(byKind.get('concept')).toBe(2);
    expect(byKind.get('insight')).toBe(1);
  });

  it('computes recent_7d and recent_30d windows', async () => {
    const now = Date.now();
    await seed('fresh', ['b'], 'concept', now - 3 * 24 * 3600 * 1000);
    await seed('two-weeks', ['b'], 'concept', now - 14 * 24 * 3600 * 1000);
    await seed('old', ['b'], 'concept', now - 60 * 24 * 3600 * 1000);

    const r = await reg().stats({});
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.recent_7d).toBe(1);
    expect(parsed.recent_30d).toBe(2);
  });

  it('counts total edges', async () => {
    const now = Date.now();
    await seed('a', ['b'], 'concept', now);
    await seed('b', ['b'], 'concept', now);
    await E.DB.prepare(
      `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES (?,?,?,?,?,?)`
    ).bind('e1', 'a', 'b', 'analogous_to', 'a long enough why for validation here', now).run();

    const r = await reg().stats({});
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.total_edges).toBe(1);
  });
});
