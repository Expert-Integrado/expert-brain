import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { registerSaveNote } from '../src/mcp/tools/save-note.js';
import { registerRecall } from '../src/mcp/tools/recall.js';
import { registerGetNote } from '../src/mcp/tools/get-note.js';
import { registerExpand } from '../src/mcp/tools/expand.js';
import { registerLink } from '../src/mcp/tools/link.js';

const E = env as any;

describe('e2e: all tools wired', () => {
  const tools: any = {};
  beforeAll(async () => {
    E.AI = { run: vi.fn(async () => ({ data: [Array(768).fill(0.1)] })) };
    E.VECTORIZE = {
      upsert: vi.fn(async () => ({})),
      query: vi.fn(async () => ({ matches: [] })),
    };
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM edges').run();
    await E.DB.prepare('DELETE FROM tags').run();
    await E.DB.prepare('DELETE FROM notes').run();
    const s: any = { registerTool: (n: string, _m: any, h: any) => { tools[n] = h; } };
    registerSaveNote(s, E); registerRecall(s, E); registerGetNote(s, E);
    registerExpand(s, E); registerLink(s, E);
  });

  it('save → link → get flow works', async () => {
    const a = await tools.save_note({
      title: 'Red Queen', body: 'coevolution body',
      tldr: 'coevolution forces constant running just to stay in place',
      domains: ['evolutionary-biology'],
      kind: 'concept',
    });
    const b = await tools.save_note({
      title: 'Tech debt spiral', body: 'compounding',
      tldr: 'unpaid debt accrues interest via slower future work',
      domains: ['software-engineering'],
      kind: 'pattern',
    });
    const aId = JSON.parse(a.content[0].text).id;
    const bId = JSON.parse(b.content[0].text).id;

    const linked = await tools.link({
      from_id: aId, to_id: bId, relation_type: 'analogous_to',
      why: 'Both describe systems where cost of inaction compounds over time',
    });
    expect(linked.isError).toBeUndefined();

    const full = await tools.get_note({ id: aId });
    const fp = JSON.parse(full.content[0].text);
    expect(fp.edges.out.length).toBe(1);
  });
});
