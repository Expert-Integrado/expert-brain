import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { AuthContext } from '../../src/env.js';
import { runMigrations } from '../../src/db/migrate.js';
import { registerDeleteLink } from '../../src/mcp/tools/delete-link.js';

const E = env as any;

function reg(auth?: AuthContext) {
  const r: any = {};
  registerDeleteLink({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, auth);
  return r;
}

async function seedNote(id: string) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,'','tl','[]','concept',0,0,null)`
  ).bind(id, id).run();
}

async function seedEdge(from: string, to: string, rel: string, why: string) {
  await E.DB.prepare(
    `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES (?,?,?,?,?,?)`
  ).bind(`e-${from}-${to}`, from, to, rel, why, 0).run();
}

describe('delete_link', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM notes');
    // Mock KV pra não depender do binding real no test env.
    E.GRAPH_CACHE = { delete: vi.fn(async () => {}) };
    await seedNote('a');
    await seedNote('b');
  });

  it('happy path: removes the edge and returns why_removed', async () => {
    await seedEdge('a', 'b', 'analogous_to', 'shared feedback loop mechanism here');
    const r = await reg().delete_link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', confirm: true });
    expect(r.isError).toBeUndefined();
    const p = JSON.parse(r.content[0].text);
    expect(p.deleted).toBe(true);
    expect(p.why_removed).toBe('shared feedback loop mechanism here');
    const count = await E.DB.prepare(`SELECT count(*) c FROM edges`).first();
    expect(count.c).toBe(0);
    // Spec 26: a invalidação do cache do grafo passou a ser AUTOMÁTICA via sourceHash
    // na chave do KV (deletar a edge muda COUNT/MAX(created_at) de `edges` → hash novo
    // → chave nova). invalidateGraphCache virou no-op documentado — não chama mais
    // GRAPH_CACHE.delete. O que importa é que a edge sumiu do D1 (asserção acima).
    expect(E.GRAPH_CACHE.delete).not.toHaveBeenCalled();
  });

  // Selo de privacidade (21/07/2026, alinhado ao fix do link): endpoint privado
  // fora do escopo do caller = mesma resposta de edge inexistente (não vaza a
  // tripla); com escopo, deleta normal.
  it('edge com endpoint privado: some sem escopo private, deletável com ele', async () => {
    await seedEdge('a', 'b', 'analogous_to', 'shared feedback loop mechanism here');
    await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = 'b'`).run();

    const noScope = await reg({ email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'k1' })
      .delete_link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', confirm: true });
    expect(noScope.isError).toBe(true);
    expect((await E.DB.prepare(`SELECT count(*) c FROM edges`).first()).c).toBe(1);

    const withScope = await reg({ email: 'o@x', loggedInAt: 0, scopes: 'full,private', keyId: 'k2' })
      .delete_link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', confirm: true });
    expect(withScope.isError).toBeUndefined();
    expect((await E.DB.prepare(`SELECT count(*) c FROM edges`).first()).c).toBe(0);
  });

  it('nonexistent triple: isError, suggests inverse direction + expand, no DB change', async () => {
    await seedEdge('a', 'b', 'analogous_to', 'shared feedback loop mechanism here');
    // Pede a direção invertida (b→a), que não existe.
    const r = await reg().delete_link({ from_id: 'b', to_id: 'a', relation_type: 'analogous_to', confirm: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('inverse direction');
    expect(r.content[0].text).toContain('expand');
    // a→b continua intacta
    const count = await E.DB.prepare(`SELECT count(*) c FROM edges`).first();
    expect(count.c).toBe(1);
  });
});
