import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerCapture } from '../../src/mcp/tools/capture.js';
import { registerListInbox } from '../../src/mcp/tools/list-inbox.js';
import { registerResolveInbox } from '../../src/mcp/tools/resolve-inbox.js';
import { registerAllTools } from '../../src/mcp/registry.js';
import {
  listInboxItems, getInboxItem, resolveInboxItem, countPendingInbox, insertInboxItem,
} from '../../src/db/queries.js';
import type { AuthContext } from '../../src/env.js';

const E = env as any;

function collector() {
  const tools: Record<string, any> = {};
  const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
  return { server, tools };
}

async function resetDb(): Promise<void> {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM inbox_items');
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM notes');
}

describe('capture (tool)', () => {
  beforeEach(resetDb);

  it('grava um item pendente e retorna id + pending_count', async () => {
    const c = collector(); registerCapture(c.server, E);
    const out = JSON.parse((await c.tools.capture({ text: '  ideia solta  ' })).content[0].text);
    expect(out.id).toMatch(/^ibx_/);
    expect(out.source).toBe('mcp');
    expect(out.pending_count).toBe(1);
    const row = await E.DB.prepare('SELECT body, source, triaged_at FROM inbox_items WHERE id = ?').bind(out.id).first();
    expect(row.body).toBe('ideia solta'); // trim aplicado
    expect(row.source).toBe('mcp');
    expect(row.triaged_at).toBeNull();
  });

  it('respeita source informado (trim + cap)', async () => {
    const c = collector(); registerCapture(c.server, E);
    const out = JSON.parse((await c.tools.capture({ text: 'x', source: ' telegram ' })).content[0].text);
    expect(out.source).toBe('telegram');
  });

  it('rejeita texto vazio após trim', async () => {
    const c = collector(); registerCapture(c.server, E);
    const res = await c.tools.capture({ text: '   ' });
    expect(res.isError).toBe(true);
  });

  it('vazamento: capture NÃO embeda (nunca toca AI/Vectorize) e nada entra em notes/FTS/grafo/stats', async () => {
    const aiRun = vi.fn(async () => ({ data: [Array(1024).fill(0.1)] }));
    const vecUpsert = vi.fn(async () => ({}));
    E.AI = { run: aiRun };
    E.VECTORIZE = { upsert: vecUpsert, query: vi.fn(async () => ({ matches: [] })) };

    const c = collector(); registerCapture(c.server, E);
    await c.tools.capture({ text: 'segredo que nao pode vazar em recall' });

    // Por construção: tabela separada. Nenhum embed, nenhum vetor.
    expect(aiRun).not.toHaveBeenCalled();
    expect(vecUpsert).not.toHaveBeenCalled();
    // notes / FTS / similar_edges permanecem vazios — o item vive só em inbox_items.
    const notes = await E.DB.prepare('SELECT count(*) c FROM notes').first();
    expect(notes.c).toBe(0);
    const fts = await E.DB.prepare("SELECT count(*) c FROM notes_fts WHERE notes_fts MATCH 'segredo'").first();
    expect(fts.c).toBe(0);
    const sim = await E.DB.prepare('SELECT count(*) c FROM similar_edges').first();
    expect(sim.c).toBe(0);
    const ibx = await E.DB.prepare('SELECT count(*) c FROM inbox_items').first();
    expect(ibx.c).toBe(1);
  });
});

describe('list_inbox (tool)', () => {
  beforeEach(resetDb);

  it('lista pendentes por default (mais antigo primeiro); triado some', async () => {
    // 3 itens com created_at crescente
    await insertInboxItem(E, { id: 'ibx_a', body: 'primeiro', source: 'mcp', created_at: 1000 });
    await insertInboxItem(E, { id: 'ibx_b', body: 'segundo', source: 'mcp', created_at: 2000 });
    await insertInboxItem(E, { id: 'ibx_c', body: 'terceiro', source: 'mcp', created_at: 3000 });
    await resolveInboxItem(E, 'ibx_b', 'discard', null, 5000);

    const c = collector(); registerListInbox(c.server, E);
    const out = JSON.parse((await c.tools.list_inbox({})).content[0].text);
    expect(out.items.map((i: any) => i.id)).toEqual(['ibx_a', 'ibx_c']); // ASC, sem o triado
    expect(out.pending_count).toBe(2);
    expect(out.items[0].created_brt).toBeDefined();
  });

  it('all:true inclui triados com triage_action/result_id', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'mcp', created_at: 1000 });
    await resolveInboxItem(E, 'ibx_a', 'note', 'note_123', 5000);
    const c = collector(); registerListInbox(c.server, E);
    const out = JSON.parse((await c.tools.list_inbox({ all: true })).content[0].text);
    expect(out.count).toBe(1);
    expect(out.items[0].triage_action).toBe('note');
    expect(out.items[0].result_id).toBe('note_123');
    expect(out.pending_count).toBe(0);
  });
});

describe('resolve_inbox (tool)', () => {
  beforeEach(resetDb);

  it('marca triado com action + result_id; idempotente na 2ª chamada', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'mcp', created_at: 1000 });
    const c = collector(); registerResolveInbox(c.server, E);

    const first = JSON.parse((await c.tools.resolve_inbox({ id: 'ibx_a', action: 'task', result_id: 't1' })).content[0].text);
    expect(first.action).toBe('task');
    expect(first.result_id).toBe('t1');
    expect(first.pending_count).toBe(0);

    const row = await getInboxItem(E, 'ibx_a');
    expect(row?.triage_action).toBe('task');
    expect(row?.result_id).toBe('t1');

    // 2ª chamada não sobrescreve (already_triaged) — mantém o result_id original.
    const second = JSON.parse((await c.tools.resolve_inbox({ id: 'ibx_a', action: 'discard' })).content[0].text);
    expect(second.already_triaged).toBe(true);
    expect(second.triage_action).toBe('task');
    const still = await getInboxItem(E, 'ibx_a');
    expect(still?.triage_action).toBe('task');
  });

  it('id inexistente → erro (não silencia)', async () => {
    const c = collector(); registerResolveInbox(c.server, E);
    const res = await c.tools.resolve_inbox({ id: 'nope', action: 'discard' });
    expect(res.isError).toBe(true);
  });
});

describe('gate de escopo (spec 17): PAT read não vê nenhuma das 3 tools de inbox', () => {
  function collectAll(scopes: string): Record<string, any> {
    const tools: Record<string, any> = {};
    const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
    const auth: AuthContext = { email: 'o@x', loggedInAt: 0, scopes, keyId: 'k1' };
    registerAllTools(server, E, auth);
    return tools;
  }

  it('scope read: capture/list_inbox/resolve_inbox suprimidas', () => {
    const t = collectAll('read');
    expect(t.capture).toBeUndefined();
    expect(t.list_inbox).toBeUndefined();
    expect(t.resolve_inbox).toBeUndefined();
    // sanidade: uma tool de leitura de verdade continua registrada
    expect(t.recall).toBeDefined();
  });

  it('scope full: as três registradas', () => {
    const t = collectAll('full');
    expect(t.capture).toBeDefined();
    expect(t.list_inbox).toBeDefined();
    expect(t.resolve_inbox).toBeDefined();
  });
});

describe('queries de inbox', () => {
  beforeEach(resetDb);

  it('resolveInboxItem: ok/alreadyTriaged/inexistente', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'mcp', created_at: 1000 });
    const r1 = await resolveInboxItem(E, 'ibx_a', 'discard', null, 2000);
    expect(r1).toEqual({ ok: true, alreadyTriaged: false });
    const r2 = await resolveInboxItem(E, 'ibx_a', 'note', 'n1', 3000);
    expect(r2).toEqual({ ok: false, alreadyTriaged: true });
    const r3 = await resolveInboxItem(E, 'ghost', 'discard', null, 3000);
    expect(r3).toEqual({ ok: false, alreadyTriaged: false });
  });

  it('countPendingInbox conta só pendentes', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'mcp', created_at: 1000 });
    await insertInboxItem(E, { id: 'ibx_b', body: 'y', source: 'mcp', created_at: 2000 });
    expect(await countPendingInbox(E)).toBe(2);
    await resolveInboxItem(E, 'ibx_a', 'discard', null, 3000);
    expect(await countPendingInbox(E)).toBe(1);
    const pending = await listInboxItems(E, {});
    expect(pending.map((i) => i.id)).toEqual(['ibx_b']);
  });
});
