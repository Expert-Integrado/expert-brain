import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  createApiKey, validateApiKey, revokeApiKey, listApiKeys,
  isApiKeyScope, MAX_ACTIVE_KEYS,
} from '../src/auth/api-keys.js';
import { authorizeBearer } from '../src/web/bearer-auth.js';
import { registerAllTools } from '../src/mcp/registry.js';
import { registerSaveNote } from '../src/mcp/tools/save-note.js';
import { insertNote, updateNote, deleteNote } from '../src/db/queries.js';

// Suíte da spec 10-backend/17: escopos de PAT, revogação lógica, bearer por rota,
// gate de escopo no registry e autoria de escrita (created_by/updated_by).
const E = env as any;
const OWNER = 'owner@example.com';

// Server fake que coleta { config, handler } por nome de tool (padrão da suíte).
function makeCollector() {
  const tools: Record<string, { config: any; handler: any }> = {};
  const server = {
    registerTool: (name: string, config: any, handler: any) => { tools[name] = { config, handler }; },
  } as any;
  return { server, tools };
}

const noteRow = (id: string) => ({
  id, title: `t-${id}`, body: 'body', tldr: 'uma frase concreta de teste', domains: '["operations"]',
  kind: 'concept' as const, created_at: 1, updated_at: 1,
});

describe('api-keys — escopo, validação e revogação', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM api_keys').run();
  });

  it("createApiKey scopes='read' → validateApiKey retorna scopes:'read' + keyId", async () => {
    const { row, plainKey } = await createApiKey(E, OWNER, 'ro-agent', 'read');
    const v = await validateApiKey(E, plainKey);
    expect(v).not.toBeNull();
    expect(v!.email).toBe(OWNER);
    expect(v!.scopes).toBe('read');
    expect(v!.keyId).toBe(row.id);
  });

  it("escopo default é 'full' (chave criada sem escopo)", async () => {
    const { plainKey } = await createApiKey(E, OWNER, 'default-agent');
    const v = await validateApiKey(E, plainKey);
    expect(v!.scopes).toBe('full');
  });

  it('revokeApiKey faz UPDATE (linha persiste) e validateApiKey passa a devolver null', async () => {
    const { row, plainKey } = await createApiKey(E, OWNER, 'to-revoke');
    expect(await revokeApiKey(E, OWNER, row.id)).toBe(true);

    // A linha continua no banco com revoked_at setado (trilha de auditoria).
    const persisted = await E.DB.prepare('SELECT id, revoked_at FROM api_keys WHERE id = ?')
      .bind(row.id).first();
    expect(persisted).toBeTruthy();
    expect(persisted!.revoked_at).not.toBeNull();

    // O check de revoked_at deixou de ser código morto: chave revogada = null.
    expect(await validateApiKey(E, plainKey)).toBeNull();

    // listApiKeys continua listando a chave revogada (UI mostra como revogada).
    const listed = await listApiKeys(E, OWNER);
    expect(listed.find((k) => k.id === row.id)).toBeTruthy();
  });

  it('revogar duas vezes é no-op (não sobrescreve o timestamp)', async () => {
    const { row } = await createApiKey(E, OWNER, 'dbl');
    expect(await revokeApiKey(E, OWNER, row.id)).toBe(true);
    expect(await revokeApiKey(E, OWNER, row.id)).toBe(false);
  });

  it('MAX_ACTIVE_KEYS conta só ativas — revogar libera espaço', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      const { row } = await createApiKey(E, OWNER, `k${i}`);
      ids.push(row.id);
    }
    // No teto → a próxima criação estoura.
    await expect(createApiKey(E, OWNER, 'over')).rejects.toThrow();
    // Revogar uma derruba o count → criar volta a funcionar.
    await revokeApiKey(E, OWNER, ids[0]);
    const { row } = await createApiKey(E, OWNER, 'after-revoke');
    expect(row.id).toBeTruthy();
  });

  it('isApiKeyScope valida os valores canônicos', () => {
    expect(isApiKeyScope('full')).toBe(true);
    expect(isApiKeyScope('read')).toBe(true);
    expect(isApiKeyScope('write')).toBe(false);
    expect(isApiKeyScope(undefined)).toBe(false);
    expect(isApiKeyScope('')).toBe(false);
  });
});

describe('authorizeBearer — escopo por rota', () => {
  const fakeEnv = { GRAPH_EXPORT_TOKEN: 'graph-secret-xyz', TASK_REMINDER_TOKEN: 'task-secret-abc' } as any;
  const reqWith = (tok: string) => new Request('https://x/app', { headers: { authorization: `Bearer ${tok}` } });

  it("media: aceita GRAPH_EXPORT_TOKEN, recusa TASK_REMINDER_TOKEN", async () => {
    expect(await authorizeBearer(reqWith('graph-secret-xyz'), fakeEnv, 'media')).toBe(true);
    expect(await authorizeBearer(reqWith('task-secret-abc'), fakeEnv, 'media')).toBe(false);
  });

  it('tasks: aceita os dois tokens', async () => {
    expect(await authorizeBearer(reqWith('graph-secret-xyz'), fakeEnv, 'tasks')).toBe(true);
    expect(await authorizeBearer(reqWith('task-secret-abc'), fakeEnv, 'tasks')).toBe(true);
  });

  it('graph: só GRAPH_EXPORT_TOKEN', async () => {
    expect(await authorizeBearer(reqWith('graph-secret-xyz'), fakeEnv, 'graph')).toBe(true);
    expect(await authorizeBearer(reqWith('task-secret-abc'), fakeEnv, 'graph')).toBe(false);
  });

  it('token errado recusado — tamanhos diferentes não geram caminho de retorno distinto', async () => {
    expect(await authorizeBearer(reqWith('short'), fakeEnv, 'graph')).toBe(false);
    expect(await authorizeBearer(reqWith('a-much-longer-token-than-the-expected-secret-000'), fakeEnv, 'graph')).toBe(false);
    // Sem header → false.
    expect(await authorizeBearer(new Request('https://x/app'), fakeEnv, 'graph')).toBe(false);
  });

  it('secret ausente nunca autoriza', async () => {
    const empty = {} as any;
    expect(await authorizeBearer(reqWith('anything'), empty, 'graph')).toBe(false);
    expect(await authorizeBearer(reqWith('anything'), empty, 'tasks')).toBe(false);
    expect(await authorizeBearer(reqWith('anything'), empty, 'media')).toBe(false);
  });
});

describe('registerAllTools — gate de escopo', () => {
  // readOnlyHint:false — não podem ser registradas no escopo read.
  const WRITE_TOOLS = [
    'save_note', 'update_note', 'delete_note', 'restore_note', 'link', 'delete_link',
    'reembed', 'save_task', 'complete_task', 'update_task', 'comment_task',
    'share_task', 'unshare_task', 'attach_media_to_note', 'delete_note_media',
  ];
  // readOnlyHint:true — sempre registradas (MEDIA está bindado no pool de teste).
  const READ_TOOLS = [
    'recall', 'expand', 'get_note', 'stats', 'list_tasks', 'list_tasks_due_today',
    'get_task', 'get_note_media',
  ];

  it("escopo 'full' registra tools de escrita e de leitura", () => {
    const { server, tools } = makeCollector();
    registerAllTools(server, E, { email: OWNER, loggedInAt: 0, scopes: 'full' });
    const names = Object.keys(tools);
    for (const t of WRITE_TOOLS) expect(names, `full deveria registrar ${t}`).toContain(t);
    for (const t of READ_TOOLS) expect(names, `full deveria registrar ${t}`).toContain(t);
  });

  it("escopo 'read' registra APENAS tools readOnlyHint:true", () => {
    const { server, tools } = makeCollector();
    registerAllTools(server, E, { email: OWNER, loggedInAt: 0, scopes: 'read' });
    const names = Object.keys(tools);
    for (const t of WRITE_TOOLS) expect(names, `read NÃO pode registrar ${t}`).not.toContain(t);
    for (const t of READ_TOOLS) expect(names, `read deveria registrar ${t}`).toContain(t);
    // Toda tool sobrevivente é read-only.
    for (const [name, entry] of Object.entries(tools)) {
      expect(entry.config?.annotations?.readOnlyHint, `${name} deveria ser readOnlyHint:true`).toBe(true);
    }
  });

  it('sessão OAuth (sem scopes) se comporta como full', () => {
    const { server, tools } = makeCollector();
    registerAllTools(server, E, { email: OWNER, loggedInAt: 0 });
    const names = Object.keys(tools);
    for (const t of WRITE_TOOLS) expect(names).toContain(t);
  });
});

describe('autoria de escrita — created_by / updated_by (query layer)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM notes').run();
  });

  it('insertNote grava created_by e updated_by = actor', async () => {
    await insertNote(E, noteRow('n-auth-1'), 'key_abc');
    const row = await E.DB.prepare('SELECT created_by, updated_by FROM notes WHERE id = ?')
      .bind('n-auth-1').first();
    expect(row!.created_by).toBe('key_abc');
    expect(row!.updated_by).toBe('key_abc');
  });

  it('insertNote sem actor deixa NULL', async () => {
    await insertNote(E, noteRow('n-auth-2'));
    const row = await E.DB.prepare('SELECT created_by, updated_by FROM notes WHERE id = ?')
      .bind('n-auth-2').first();
    expect(row!.created_by).toBeNull();
    expect(row!.updated_by).toBeNull();
  });

  it('updateNote grava updated_by e preserva created_by', async () => {
    await insertNote(E, noteRow('n-auth-3'), 'creator_key');
    await updateNote(E, 'n-auth-3', { title: 'novo', updated_at: 2 }, undefined, 'editor_key');
    const row = await E.DB.prepare('SELECT created_by, updated_by FROM notes WHERE id = ?')
      .bind('n-auth-3').first();
    expect(row!.created_by).toBe('creator_key');
    expect(row!.updated_by).toBe('editor_key');
  });

  it('updateNote SEM actor preserva o updated_by anterior (COALESCE, não zera)', async () => {
    await insertNote(E, noteRow('n-auth-4'), 'creator_key');
    await updateNote(E, 'n-auth-4', { title: 'z', updated_at: 3 });
    const row = await E.DB.prepare('SELECT updated_by FROM notes WHERE id = ?')
      .bind('n-auth-4').first();
    expect(row!.updated_by).toBe('creator_key');
  });

  it('deleteNote grava updated_by = actor e mantém a linha (soft-delete)', async () => {
    await insertNote(E, noteRow('n-auth-5'), 'creator_key');
    await deleteNote(E, 'n-auth-5', 'deleter_key');
    const row = await E.DB.prepare('SELECT updated_by, deleted_at FROM notes WHERE id = ?')
      .bind('n-auth-5').first();
    expect(row!.updated_by).toBe('deleter_key');
    expect(row!.deleted_at).not.toBeNull();
  });
});

describe('autoria via MCP save_note', () => {
  beforeEach(async () => {
    E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
    E.VECTORIZE = { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) };
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM notes').run();
  });

  it('PAT: keyId vai pra created_by/updated_by', async () => {
    const { server, tools } = makeCollector();
    registerSaveNote(server, E, { email: OWNER, loggedInAt: 0, scopes: 'full', keyId: 'pat_key_123' });
    const res = await tools.save_note.handler({
      title: 'A', body: 'b', tldr: 'uma frase concreta o suficiente', domains: ['operations'], kind: 'concept',
    });
    const out = JSON.parse(res.content[0].text);
    const row = await E.DB.prepare('SELECT created_by, updated_by FROM notes WHERE id = ?')
      .bind(out.id).first();
    expect(row!.created_by).toBe('pat_key_123');
    expect(row!.updated_by).toBe('pat_key_123');
  });

  it('OAuth (sem keyId): grava oauth:<email>', async () => {
    const { server, tools } = makeCollector();
    registerSaveNote(server, E, { email: OWNER, loggedInAt: 0 });
    const res = await tools.save_note.handler({
      title: 'B', body: 'b', tldr: 'outra frase concreta de teste', domains: ['operations'], kind: 'concept',
    });
    const out = JSON.parse(res.content[0].text);
    const row = await E.DB.prepare('SELECT created_by FROM notes WHERE id = ?')
      .bind(out.id).first();
    expect(row!.created_by).toBe(`oauth:${OWNER}`);
  });
});
