import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerRestoreNote } from '../../src/mcp/tools/restore-note.js';

const E = env as any;

describe('restore_note', () => {
  beforeEach(async () => {
    E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.2)] })) };
    E.VECTORIZE = { upsert: vi.fn(async () => ({})), query: vi.fn() };
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('abc','Title','body','a tldr long enough','["biology"]','idea',1,1,null)`
    ).run();
  });

  function reg() {
    const r: any = {};
    registerRestoreNote({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
    return r;
  }

  it('restaura uma nota soft-deletada e re-embeda o vetor', async () => {
    await E.DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').bind(123, 'abc').run();
    // confirmada como deletada (some das leituras normais)
    const gone = await E.DB.prepare('SELECT id FROM notes WHERE id=? AND deleted_at IS NULL').bind('abc').first();
    expect(gone).toBeNull();

    const r = await reg().restore_note({ id: 'abc' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.restored).toBe(true);

    // voltou pras leituras normais (deleted_at NULL)
    const back = await E.DB.prepare('SELECT deleted_at FROM notes WHERE id=?').bind('abc').first();
    expect(back.deleted_at).toBeNull();
    // re-embed: chamou AI + upsert no Vectorize
    expect(E.AI.run).toHaveBeenCalledTimes(1);
    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it('nota que nao esta deletada: nao faz nada (restored=false, sem re-embed)', async () => {
    const r = await reg().restore_note({ id: 'abc' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.restored).toBe(false);
    expect(E.AI.run).not.toHaveBeenCalled();
    expect(E.VECTORIZE.upsert).not.toHaveBeenCalled();
  });

  it('rejeita id inexistente', async () => {
    const r = await reg().restore_note({ id: 'ghost' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
  });
});
