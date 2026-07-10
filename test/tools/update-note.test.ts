import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerUpdateNote } from '../../src/mcp/tools/update-note.js';

const E = env as any;
const AUTH = { email: 'test@example.com', loggedInAt: 0 };

function fakeAI() {
  return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.3)] })) };
}
function fakeVectorize() {
  return { upsert: vi.fn(async () => ({})), query: vi.fn() };
}

async function resetDb(): Promise<void> {
  await E.DB.prepare('DELETE FROM edges').run();
  await E.DB.prepare('DELETE FROM tags').run();
  await E.DB.prepare('DELETE FROM notes').run();
}

async function seed(id: string, tldr: string, domains: string, kind: string): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, 'Original Title', 'original body', tldr, domains, kind, 1000, 1000).run();
}

function reg() {
  const r: any = {};
  registerUpdateNote({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, AUTH);
  return r;
}

describe('update_note', () => {
  beforeEach(async () => {
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await resetDb();
  });

  it('updates title without reembedding', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', title: 'New Title' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toEqual(['title']);
    expect(parsed.reembedded).toBe(false);
    expect(E.AI.run).not.toHaveBeenCalled();
    const row = await E.DB.prepare('SELECT title FROM notes WHERE id = ?').bind('abc').first();
    expect(row.title).toBe('New Title');
  });

  it('reembeds when tldr changes', async () => {
    await seed('abc', 'old tldr long enough', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', tldr: 'a brand new tldr long enough here ok' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('tldr');
    expect(parsed.reembedded).toBe(true);
    expect(E.AI.run).toHaveBeenCalledTimes(1);
    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it('reembeds when domains change (metadata must follow)', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', domains: ['product'] });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('domains');
    expect(parsed.reembedded).toBe(true);
  });

  it('reembeds when kind changes', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', kind: 'principle' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('kind');
    expect(parsed.reembedded).toBe(true);
  });

  it('replaces tags without reembedding', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    await E.DB.prepare(`INSERT INTO tags (note_id, tag) VALUES (?, ?)`).bind('abc', 'old').run();
    const r = await reg().update_note({ id: 'abc', tags: ['new1', 'new2'] });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('tags');
    expect(parsed.reembedded).toBe(false);
    const tags = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = ? ORDER BY tag`).bind('abc').all();
    expect(tags.results.map((t: any) => t.tag)).toEqual(['new1', 'new2']);
  });

  it('rejects when only id is provided', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('at least one field');
  });

  it('rejects unknown id', async () => {
    const r = await reg().update_note({ id: 'ghost', title: 'X' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
  });

  it('rejects invalid domain slug', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', domains: ['Biologia Evolutiva'] });
    expect(r.isError).toBe(true);
  });

  it('handles legacy note with kind=null when reembedding (no NoteKind crash)', async () => {
    // Direct insert with kind=null simulates a legacy row from before kind became required.
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind('legacy', 'T', 'b', 'an old tldr long enough', '["biology"]', null, 1000, 1000).run();

    const r = await reg().update_note({ id: 'legacy', tldr: 'a freshly rewritten tldr that qualifies' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.reembedded).toBe(true);

    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = (E.VECTORIZE.upsert.mock.calls[0] as any[])[0][0];
    expect(upsertArg.metadata.kind).toBe(''); // upsertNoteVector coerces null -> ''
  });

  it('bumps updated_at when only tags change', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const before = await E.DB.prepare('SELECT updated_at FROM notes WHERE id = ?').bind('abc').first();
    expect(before.updated_at).toBe(1000);

    const r = await reg().update_note({ id: 'abc', tags: ['fresh'] });
    expect(r.isError).toBeUndefined();
    const after = await E.DB.prepare('SELECT updated_at FROM notes WHERE id = ?').bind('abc').first();
    expect(after.updated_at).toBeGreaterThan(1000);
  });

  it('tags=[] clears existing tags', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    await E.DB.prepare(`INSERT INTO tags (note_id, tag) VALUES (?, ?)`).bind('abc', 'old').run();
    const r = await reg().update_note({ id: 'abc', tags: [] });
    expect(r.isError).toBeUndefined();
    const remaining = await E.DB.prepare('SELECT count(*) c FROM tags WHERE note_id = ?').bind('abc').first();
    expect(remaining.c).toBe(0);
  });
});

// spec 70-grafo-higiene/76: update_note passa a devolver possible_duplicates
// (mesmo shape do save_note, spec 71) quando o re-embed aproxima a nota editada
// de outra já existente — a MESMA consulta que persiste as similar_edges agora
// alimenta o caller, sem uma segunda chamada ao Vectorize.
describe('update_note — possible_duplicates via reembed (spec 76)', () => {
  const PAT_AUTH = { email: 'pat@example.com', loggedInAt: 0, keyId: 'key_test_pat', scopes: 'full' };

  beforeEach(async () => {
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await resetDb();
  });

  async function seedTarget(
    id: string, title: string, tldr: string, opts: { private?: boolean } = {}
  ): Promise<void> {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(id, title, 'corpo de teste', tldr, '["operations"]', 'concept', opts.private ? 1 : 0, 1000, 1000).run();
  }

  it('reembed que aproxima de nota existente (score >= DEDUP_MIN_SCORE) devolve possible_duplicates hidratado', async () => {
    await seed('abc', 'tldr original suficiente aqui', '["operations"]', 'concept');
    await seedTarget('dup-1', 'Nota quase igual', 'tldr da nota quase igual ja existente');
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'dup-1', score: 0.86 }] }));
    const r = await reg().update_note({ id: 'abc', tldr: 'um tldr novo que fica parecido com outra nota' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.reembedded).toBe(true);
    expect(parsed.possible_duplicates).toEqual([
      { id: 'dup-1', title: 'Nota quase igual', tldr: 'tldr da nota quase igual ja existente', score: 0.86, reason: 'vector' },
    ]);
  });

  it('match abaixo do gate (score < DEDUP_MIN_SCORE) não aparece — campo ausente', async () => {
    await seed('abc', 'tldr original suficiente aqui', '["operations"]', 'concept');
    await seedTarget('nb-1', 'Vizinha legitima', 'tldr da vizinha legitima');
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'nb-1', score: 0.72 }] }));
    const r = await reg().update_note({ id: 'abc', tldr: 'outro tldr novo bem distinto de tudo' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.possible_duplicates).toBeUndefined();
  });

  it('a própria nota reindexada não aparece como seu próprio possible_duplicate (self filtrado)', async () => {
    await seed('abc', 'tldr original suficiente aqui', '["operations"]', 'concept');
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'abc', score: 0.99 }] }));
    const r = await reg().update_note({ id: 'abc', tldr: 'um tldr bem novo e diferente por completo' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.possible_duplicates).toBeUndefined();
  });

  it('edição sem mudança semântica não consulta o Vectorize e não devolve possible_duplicates', async () => {
    await seed('abc', 'tldr original suficiente aqui', '["operations"]', 'concept');
    const r = await reg().update_note({ id: 'abc', title: 'Só o título mudou' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.reembedded).toBe(false);
    expect(parsed.possible_duplicates).toBeUndefined();
    expect(E.VECTORIZE.query).not.toHaveBeenCalled();
  });

  it('candidato privado some pra PAT sem escopo private; dono vê o mesmo candidato', async () => {
    await seed('abc', 'tldr original suficiente aqui', '["operations"]', 'concept');
    await seedTarget('priv-1', 'Nota privada', 'tldr da nota privada ja existente', { private: true });
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'priv-1', score: 0.9 }] }));

    const patHandlers: any = {};
    registerUpdateNote({ registerTool: (n: string, _m: any, h: any) => { patHandlers[n] = h; } } as any, E, PAT_AUTH);
    const rPat = await patHandlers.update_note({ id: 'abc', tldr: 'tldr colidindo com a nota privada ja existente' });
    expect(rPat.isError).toBeUndefined();
    const pPat = JSON.parse(rPat.content[0].text);
    expect(pPat.possible_duplicates).toBeUndefined();

    const ownerHandlers: any = {};
    registerUpdateNote({ registerTool: (n: string, _m: any, h: any) => { ownerHandlers[n] = h; } } as any, E, AUTH);
    const rOwner = await ownerHandlers.update_note({ id: 'abc', tldr: 'tldr colidindo com a nota privada de novo aqui' });
    const pOwner = JSON.parse(rOwner.content[0].text);
    expect((pOwner.possible_duplicates ?? []).map((d: any) => d.id)).toContain('priv-1');
  });
});

// spec 10-backend/23: update_note grava o D1 ANTES de embedar — quando o embed
// estoura, a edição JÁ persistiu e a mensagem de erro não pode dizer o contrário.
describe('update_note with embed failure (spec 23)', () => {
  beforeEach(async () => {
    E.AI = { run: vi.fn(async () => { throw new Error('AiError: Workers AI capacity exceeded'); }) };
    E.VECTORIZE = { upsert: vi.fn(async () => ({})), query: vi.fn() };
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM edges').run();
    await E.DB.prepare('DELETE FROM tags').run();
    await E.DB.prepare('DELETE FROM notes').run();
  });

  it('D1 keeps the new tldr and the error message never claims nothing persisted', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind('abc', 'Original Title', 'original body', 'the old tldr text here', '["biology"]', 'concept', 1000, 1000).run();

    const r = await reg().update_note({ id: 'abc', tldr: 'a freshly rewritten tldr that qualifies' });
    expect(r.isError).toBe(true);
    const text = r.content[0].text as string;
    // orienta verificar e reembedar, sem afirmar que nada foi salvo
    expect(text).toContain('get_note');
    expect(text).toContain('reembed');
    expect(text).not.toContain('was NOT saved');
    expect(text).not.toContain('there are no partial writes');
    // e o D1 de fato ficou com o tldr novo (partial write é o comportamento normal)
    const row = await E.DB.prepare('SELECT tldr FROM notes WHERE id = ?').bind('abc').first();
    expect(row.tldr).toBe('a freshly rewritten tldr that qualifies');
  });
});

describe('update_note — coalescing de tldr (auditoria 07/2026)', () => {
  beforeEach(async () => {
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await resetDb();
  });

  it('tldr acima de 280 salva truncado + devolve warning', async () => {
    await seed('abc', 'old tldr long enough', '["operations"]', 'concept');
    const longTldr = 'w'.repeat(350);
    const r = await reg().update_note({ id: 'abc', tldr: longTldr });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.tldr_truncated).toBe(true);
    expect(parsed.warning).toContain('350');
    const row = await E.DB.prepare('SELECT tldr FROM notes WHERE id = ?').bind('abc').first();
    expect(row.tldr.length).toBe(280);
    expect(row.tldr.endsWith('...')).toBe(true);
  });

  it('tldr dentro do limite: sem warning, sem tldr_truncated', async () => {
    await seed('abc', 'old tldr long enough', '["operations"]', 'concept');
    const r = await reg().update_note({ id: 'abc', tldr: 'a normal new tldr that fits fine' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.tldr_truncated).toBeUndefined();
    expect(parsed.warning).toBeUndefined();
  });
});
