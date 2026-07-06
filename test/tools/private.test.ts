import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { hasScope } from '../../src/auth/api-keys.js';
import { registerAllTools } from '../../src/mcp/registry.js';
import { registerRecall } from '../../src/mcp/tools/recall.js';
import { registerGetNote } from '../../src/mcp/tools/get-note.js';
import { registerExpand } from '../../src/mcp/tools/expand.js';
import { registerStats } from '../../src/mcp/tools/stats.js';
import { registerSaveNote } from '../../src/mcp/tools/save-note.js';
import { registerUpdateNote } from '../../src/mcp/tools/update-note.js';
import { registerMarkPrivate } from '../../src/mcp/tools/mark-private.js';
import { ftsSearch, getNoteById } from '../../src/db/queries.js';
import type { AuthContext } from '../../src/env.js';

// Suíte do SELO DE PRIVACIDADE (spec 30-features/31): teste de vazamento POR SUPERFÍCIE.
// Uma nota `private = 1` NUNCA pode aparecer (nem em contagem) pra uma credencial sem o
// escopo `private`, em NENHUM read path MCP (recall com/sem domains_filter, FTS, get_note,
// expand base+vizinhos, stats). A sessão do dono e o PAT com escopo veem tudo.
const E = env as any;

// Callers (AuthContext): PAT full SEM private (não vê), PAT full,private (vê), sessão
// OAuth do dono (sem keyId → vê), PAT read (não vê), PAT read,private (vê).
const NO_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'k_nopriv' };
const WITH_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full,private', keyId: 'k_priv' };
const OWNER_OAUTH: AuthContext = { email: 'o@x', loggedInAt: 0 }; // sem keyId = dono logado

function collector() {
  const tools: Record<string, any> = {};
  const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
  return { server, tools };
}

// pub1/pub2 públicas + priv1 privada. Edges: pub1→pub2 (público↔público) e pub1→priv1
// (público↔privado). Todas com o token 'quantum' no corpo pra casar no FTS.
async function seed() {
  const ins = (id: string, title: string, tldr: string, dom: string, kind: string, priv: number) =>
    E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at,deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL)`
    ).bind(id, title, 'shared quantum body text', tldr, dom, kind, priv, 1000, 1000).run();
  await ins('pub1', 'Public alpha', 'public marketing funnel idea', '["marketing"]', 'concept', 0);
  await ins('pub2', 'Public beta', 'public operations checklist idea', '["operations"]', 'concept', 0);
  await ins('priv1', 'Secret note', 'confidential leadership decision', '["leadership"]', 'decision', 1);
  await E.DB.prepare(
    `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES (?,?,?,?,?,?)`
  ).bind('e_pubpub', 'pub1', 'pub2', 'analogous_to', 'both are public control ideas here', 1000).run();
  await E.DB.prepare(
    `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES (?,?,?,?,?,?)`
  ).bind('e_pubpriv', 'pub1', 'priv1', 'analogous_to', 'links a public note to a private one', 1000).run();
}

function mockAiVectorize(matchIds: string[]) {
  E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
  E.VECTORIZE = {
    upsert: vi.fn(async () => ({})),
    query: vi.fn(async () => ({ matches: matchIds.map((id, i) => ({ id, score: 0.9 - i * 0.01 })) })),
  };
}

async function resetDb() {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM notes');
}

describe('selo de privacidade — read paths MCP (vazamento por superfície)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAiVectorize(['pub1', 'pub2', 'priv1']);
    await seed();
  });

  // ── recall (vetor + FTS) ──────────────────────────────────────────────
  it('recall: caller SEM escopo não recebe a nota privada', async () => {
    const { server, tools } = collector();
    registerRecall(server, E, NO_PRIV);
    const parsed = JSON.parse((await tools.recall({ query: 'quantum', limit: 30 })).content[0].text);
    const ids = parsed.results.map((r: any) => r.id);
    expect(ids).toContain('pub1');
    expect(ids).toContain('pub2');
    expect(ids).not.toContain('priv1');
  });

  it('recall: caller COM escopo recebe a nota privada', async () => {
    const { server, tools } = collector();
    registerRecall(server, E, WITH_PRIV);
    const parsed = JSON.parse((await tools.recall({ query: 'quantum', limit: 30 })).content[0].text);
    expect(parsed.results.map((r: any) => r.id)).toContain('priv1');
  });

  it('recall: sessão OAuth do dono (sem keyId) recebe a nota privada', async () => {
    const { server, tools } = collector();
    registerRecall(server, E, OWNER_OAUTH);
    const parsed = JSON.parse((await tools.recall({ query: 'quantum', limit: 30 })).content[0].text);
    expect(parsed.results.map((r: any) => r.id)).toContain('priv1');
  });

  // ── recall com domains_filter (pool por domínio) ──────────────────────
  it('recall domains_filter do domínio da privada: SEM escopo não vaza', async () => {
    mockAiVectorize([]); // sem match semântico — só o retrieval por domínio traria a nota
    const { server, tools } = collector();
    registerRecall(server, E, NO_PRIV);
    const parsed = JSON.parse(
      (await tools.recall({ query: 'anything', domains_filter: ['leadership'], limit: 30 })).content[0].text
    );
    expect(parsed.results.map((r: any) => r.id)).not.toContain('priv1');
  });

  it('recall domains_filter do domínio da privada: COM escopo traz a nota', async () => {
    mockAiVectorize([]);
    const { server, tools } = collector();
    registerRecall(server, E, WITH_PRIV);
    const parsed = JSON.parse(
      (await tools.recall({ query: 'anything', domains_filter: ['leadership'], limit: 30 })).content[0].text
    );
    expect(parsed.results.map((r: any) => r.id)).toContain('priv1');
  });

  // ── ftsSearch (caminho FTS direto) ────────────────────────────────────
  it('ftsSearch: includePrivate=false esconde a privada; true a revela', async () => {
    const without = await ftsSearch(E, 'quantum', 30, false, false);
    expect(without.map((r) => r.id)).not.toContain('priv1');
    expect(without.map((r) => r.id)).toContain('pub1');
    const withPriv = await ftsSearch(E, 'quantum', 30, false, true);
    expect(withPriv.map((r) => r.id)).toContain('priv1');
  });

  // ── get_note ──────────────────────────────────────────────────────────
  it('get_note(priv): SEM escopo = mesmo "not found" de nota inexistente', async () => {
    const { server, tools } = collector();
    registerGetNote(server, E, NO_PRIV);
    const res = await tools.get_note({ id: 'priv1' });
    expect(res.isError).toBe(true);
    // Indistinguível de inexistente: a mensagem da nota privada é BYTE-idêntica à de um
    // id genuinamente ausente (só troca o id ecoado) — nada denuncia que priv1 existe.
    const ghost = await tools.get_note({ id: 'priv1x' });
    expect(res.content[0].text).toBe(ghost.content[0].text.replace('priv1x', 'priv1'));
    expect(res.content[0].text).not.toMatch(/privad|private|scope|escopo/i);
  });

  it('get_note(priv): COM escopo retorna a nota', async () => {
    const { server, tools } = collector();
    registerGetNote(server, E, WITH_PRIV);
    const res = await tools.get_note({ id: 'priv1' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text).id).toBe('priv1');
  });

  it('get_note(pub): SEM escopo não lista vizinho privado nos edges', async () => {
    const { server, tools } = collector();
    registerGetNote(server, E, NO_PRIV);
    const parsed = JSON.parse((await tools.get_note({ id: 'pub1' })).content[0].text);
    const outIds = parsed.edges.out.map((e: any) => e.to_id);
    expect(outIds).toContain('pub2');
    expect(outIds).not.toContain('priv1');
  });

  it('get_note(pub): COM escopo lista o vizinho privado', async () => {
    const { server, tools } = collector();
    registerGetNote(server, E, WITH_PRIV);
    const parsed = JSON.parse((await tools.get_note({ id: 'pub1' })).content[0].text);
    expect(parsed.edges.out.map((e: any) => e.to_id)).toContain('priv1');
  });

  // ── expand ──────────────────────────────────────────────────────────────
  it('expand(pub): SEM escopo omite vizinho privado, mantém o público', async () => {
    const { server, tools } = collector();
    registerExpand(server, E, NO_PRIV);
    const parsed = JSON.parse((await tools.expand({ note_id: 'pub1' })).content[0].text);
    const ids = parsed.neighbors.map((n: any) => n.note.id);
    expect(ids).toContain('pub2');
    expect(ids).not.toContain('priv1');
  });

  it('expand(pub): COM escopo inclui o vizinho privado', async () => {
    const { server, tools } = collector();
    registerExpand(server, E, WITH_PRIV);
    const parsed = JSON.parse((await tools.expand({ note_id: 'pub1' })).content[0].text);
    expect(parsed.neighbors.map((n: any) => n.note.id)).toContain('priv1');
  });

  it('expand(priv): SEM escopo = not found; COM escopo resolve', async () => {
    const c1 = collector(); registerExpand(c1.server, E, NO_PRIV);
    expect((await c1.tools.expand({ note_id: 'priv1' })).isError).toBe(true);
    const c2 = collector(); registerExpand(c2.server, E, WITH_PRIV);
    expect((await c2.tools.expand({ note_id: 'priv1' })).isError).toBeUndefined();
  });

  // ── stats ────────────────────────────────────────────────────────────────
  it('stats: SEM escopo não conta a privada (nota, edge privada, kind, private_notes)', async () => {
    const { server, tools } = collector();
    registerStats(server, E, NO_PRIV);
    const p = JSON.parse((await tools.stats({})).content[0].text);
    expect(p.total_notes).toBe(2);
    // Só a edge público↔público conta; a que toca a privada é excluída.
    expect(p.total_edges).toBe(1);
    // O kind exclusivo da privada (decision) não aparece.
    expect(p.notes_by_kind.map((k: any) => k.kind)).not.toContain('decision');
    // O domínio exclusivo da privada (leadership) não aparece.
    expect(p.notes_by_domain.map((d: any) => d.domain)).not.toContain('leadership');
    // Sem escopo, nem o contador de privadas é exposto.
    expect(p.private_notes).toBeUndefined();
  });

  it('stats: COM escopo conta tudo e expõe private_notes', async () => {
    const { server, tools } = collector();
    registerStats(server, E, WITH_PRIV);
    const p = JSON.parse((await tools.stats({})).content[0].text);
    expect(p.total_notes).toBe(3);
    expect(p.total_edges).toBe(2);
    expect(p.notes_by_kind.map((k: any) => k.kind)).toContain('decision');
    expect(p.notes_by_domain.map((d: any) => d.domain)).toContain('leadership');
    expect(p.private_notes).toBe(1);
  });
});

describe('selo de privacidade — escrita (save/update/mark_private)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAiVectorize([]);
    await seed();
  });

  it('save_note com private:true grava private = 1', async () => {
    const { server, tools } = collector();
    registerSaveNote(server, E, WITH_PRIV);
    const out = JSON.parse((await tools.save_note({
      title: 'Nova privada', body: 'b', tldr: 'uma frase concreta o suficiente',
      domains: ['operations'], kind: 'concept', private: true,
    })).content[0].text);
    const row = await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind(out.id).first();
    expect(row.private).toBe(1);
  });

  it('save_note sem private grava private = 0 (default)', async () => {
    const { server, tools } = collector();
    registerSaveNote(server, E, WITH_PRIV);
    const out = JSON.parse((await tools.save_note({
      title: 'Nova pública', body: 'b', tldr: 'outra frase concreta o suficiente',
      domains: ['operations'], kind: 'concept',
    })).content[0].text);
    const row = await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind(out.id).first();
    expect(row.private).toBe(0);
  });

  it('update_note com private:true marca a nota', async () => {
    const { server, tools } = collector();
    registerUpdateNote(server, E, WITH_PRIV);
    E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
    const res = await tools.update_note({ id: 'pub1', private: true });
    expect(res.isError).toBeUndefined();
    const row = await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind('pub1').first();
    expect(row.private).toBe(1);
    // Marcar privada NÃO reembeda (não muda tldr/domains/kind).
    expect(E.AI.run).not.toHaveBeenCalled();
  });

  it('update_note com private:false retorna erro orientando pra UI', async () => {
    const { server, tools } = collector();
    registerUpdateNote(server, E, WITH_PRIV);
    const res = await tools.update_note({ id: 'priv1', private: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('/app/notes/priv1');
  });

  it('mark_private marca uma nota visível e é idempotente', async () => {
    const { server, tools } = collector();
    registerMarkPrivate(server, E, WITH_PRIV);
    E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
    const r1 = await tools.mark_private({ id: 'pub1' });
    expect(r1.isError).toBeUndefined();
    expect((await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind('pub1').first()).private).toBe(1);
    // Idempotente: re-marcar (caller vê privadas) segue OK, private continua 1.
    const r2 = await tools.mark_private({ id: 'pub1' });
    expect(r2.isError).toBeUndefined();
    expect((await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind('pub1').first()).private).toBe(1);
    // Não reembeda.
    expect(E.AI.run).not.toHaveBeenCalled();
  });

  it('mark_private recusa task', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,private,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
       VALUES ('t1','T','b','tl','["operations"]','task',0,'open',NULL,NULL,NULL,1,1,NULL)`
    ).run();
    const { server, tools } = collector();
    registerMarkPrivate(server, E, WITH_PRIV);
    const res = await tools.mark_private({ id: 't1' });
    expect(res.isError).toBe(true);
  });

  it('não existe tool de DESMARCAR privada', () => {
    const { server, tools } = collector();
    registerAllTools(server, E, { email: 'o@x', loggedInAt: 0, scopes: 'full,private' });
    const names = Object.keys(tools);
    expect(names).toContain('mark_private');
    expect(names).not.toContain('mark_public');
    expect(names).not.toContain('unmark_private');
  });
});

describe('hasScope + gate de escopo com CSV', () => {
  it('hasScope: base sem private não contém; read,private contém read e private', () => {
    expect(hasScope('full', 'private')).toBe(false);
    expect(hasScope('read', 'private')).toBe(false);
    expect(hasScope('full,private', 'private')).toBe(true);
    expect(hasScope('read,private', 'private')).toBe(true);
    expect(hasScope('read,private', 'read')).toBe(true);
    expect(hasScope(undefined, 'private')).toBe(false); // ausente = 'full'
    expect(hasScope(undefined, 'read')).toBe(false);
  });

  it("registry: 'read,private' continua read-only (não registra tools de escrita)", async () => {
    await resetDb();
    const { server, tools } = collector();
    // collector() só guarda handlers; pro gate por annotation preciso do config.
    const tools2: Record<string, any> = {};
    const server2: any = { registerTool: (n: string, c: any, _h: any) => { tools2[n] = c; } };
    registerAllTools(server2, E, { email: 'o@x', loggedInAt: 0, scopes: 'read,private' });
    const names = Object.keys(tools2);
    // Read-only: as tools de escrita NÃO são registradas mesmo com ,private.
    expect(names).not.toContain('save_note');
    expect(names).not.toContain('update_note');
    expect(names).not.toContain('mark_private');
    // Read tools presentes.
    expect(names).toContain('recall');
    expect(names).toContain('get_note');
    // Silencia unused.
    void server; void tools;
  });
});

describe('selo de privacidade — toggle web POST /app/notes/{id}/private', () => {
  async function cookie(): Promise<string> {
    const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
    return `eb_session=${token}`;
  }
  function post(id: string, priv: boolean, ck?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (ck) headers.cookie = ck;
    return SELF.fetch(`https://x/app/notes/${id}/private`, {
      method: 'POST', headers, body: JSON.stringify({ private: priv }), redirect: 'manual',
    });
  }

  beforeEach(async () => {
    await resetDb();
    mockAiVectorize([]);
    await seed();
  });

  it('marca e DESMARCA nos dois sentidos com sessão', async () => {
    const ck = await cookie();
    const r1 = await post('pub1', true, ck);
    expect(r1.status).toBe(200);
    expect((await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind('pub1').first()).private).toBe(1);
    const r2 = await post('pub1', false, ck);
    expect(r2.status).toBe(200);
    expect((await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind('pub1').first()).private).toBe(0);
  });

  it('sem sessão: 401 (JSON) e NÃO altera o estado', async () => {
    const res = await post('pub1', true);
    expect(res.status).toBe(401);
    expect((await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind('pub1').first()).private).toBe(0);
  });

  it('task → 404 (privacidade de task é outra spec)', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,private,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
       VALUES ('t1','T','b','tl','["operations"]','task',0,'open',NULL,NULL,NULL,1,1,NULL)`
    ).run();
    const ck = await cookie();
    const res = await post('t1', true, ck);
    expect(res.status).toBe(404);
  });
});
