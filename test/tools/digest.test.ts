import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerDigest } from '../../src/mcp/tools/digest.js';
import { registerAllTools } from '../../src/mcp/registry.js';
import { RESURFACE_DIGEST_META_KEY } from '../../src/digest/resurface.js';
import type { AuthContext } from '../../src/env.js';

// Tool MCP `digest` (specs/50-console-v2/64-resurfacing-digest.md, critério 5).

const E = env as any;

const OWNER: AuthContext = { email: 'o@x', loggedInAt: 0 }; // sessão OAuth, sem keyId = vê privados
const FULL_NO_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'k1' };
const FULL_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full,private', keyId: 'k2' };

function collector() {
  const tools: Record<string, any> = {};
  const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
  return { server, tools };
}

async function resetDb(): Promise<void> {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM edges');
  await E.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).run();
}

beforeEach(async () => {
  await resetDb();
  E.WORKER_URL = 'https://brain.test';
  E.CONTACTS = undefined;
  E.CONTACTS_PROXY_TOKEN = undefined;
});

describe('digest (tool) — payload', () => {
  it('devolve o payload versionado com as 4 seções', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
       VALUES ('q1','Pergunta','b','tldr','["operations"]','question',?,?)`
    ).bind(Date.now() - 40 * 24 * 3600_000, Date.now() - 40 * 24 * 3600_000).run();

    const { tools } = collector();
    registerDigest({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.digest({});
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out.version).toBe(1);
    expect(out.open_questions).toHaveLength(1);
    expect(out.open_questions[0].id).toBe('q1');
    expect(out.contacts_degraded).toBe(true); // CONTACTS não configurado neste teste
  });
});

describe('gate de escopo (spec 17): PAT read não vê a tool digest', () => {
  function collectAll(scopes: string): Record<string, any> {
    const tools: Record<string, any> = {};
    const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
    const auth: AuthContext = { email: 'o@x', loggedInAt: 0, scopes, keyId: 'k1' };
    registerAllTools(server, E, auth);
    return tools;
  }

  it('scope read: digest suprimida', () => {
    const t = collectAll('read');
    expect(t.digest).toBeUndefined();
    expect(t.recall).toBeDefined(); // sanidade
  });

  it('scope full: digest registrada', () => {
    const t = collectAll('full');
    expect(t.digest).toBeDefined();
  });
});

describe('privacidade (spec 31): PAT full sem `private` nunca vê/grava o cache do dono', () => {
  async function seedPrivateQuestion() {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at)
       VALUES ('qpriv','Pergunta privada','b','tldr','["operations"]','question',1,?,?)`
    ).bind(Date.now() - 40 * 24 * 3600_000, Date.now() - 40 * 24 * 3600_000).run();
  }

  it('PAT full sem private: não vê a pergunta privada e não escreve o cache', async () => {
    await seedPrivateQuestion();
    const { tools } = collector();
    registerDigest({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, FULL_NO_PRIV);
    const out = JSON.parse((await tools.digest({})).content[0].text);
    expect(out.open_questions).toEqual([]);
    const row = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).first();
    expect(row).toBeNull();
  });

  it('PAT full,private: vê a pergunta privada e usa o cache do dono', async () => {
    await seedPrivateQuestion();
    const { tools } = collector();
    registerDigest({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, FULL_PRIV);
    const out = JSON.parse((await tools.digest({})).content[0].text);
    expect(out.open_questions.map((q: any) => q.id)).toEqual(['qpriv']);
    const row = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).first();
    expect(row).not.toBeNull();
  });

  it('sessão OAuth do dono: vê a pergunta privada', async () => {
    await seedPrivateQuestion();
    const { tools } = collector();
    registerDigest({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const out = JSON.parse((await tools.digest({})).content[0].text);
    expect(out.open_questions.map((q: any) => q.id)).toEqual(['qpriv']);
  });
});
