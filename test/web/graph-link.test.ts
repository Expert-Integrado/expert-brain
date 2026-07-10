import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { handleGraphLink } from '../../src/web/graph-data.js';

// TDD da spec 70-grafo-higiene/75: o gate de higiene do MCP (isLazyWhy, spec 71)
// precisa valer TAMBÉM em POST /app/graph/link — hoje só checa why.length >= 20,
// deixando passar um why "genérico" de 25+ chars que o MCP rejeitaria.

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function linkReq(body: unknown, cookieHeader: string): Request {
  return new Request('https://x/app/graph/link', {
    method: 'POST',
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /app/graph/link — paridade do gate de higiene com o MCP (spec 75)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('a','A','','tl','[]',null,0,0,null)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('b','B','','tl','[]',null,0,0,null)`).run();
  });

  it('why >= 20 chars mas só genérico (isLazyWhy) é rejeitado com 400 e a mensagem do lazyWhyError', async () => {
    const cookieHeader = await cookie();
    const res = await handleGraphLink(
      linkReq({ source: 'a', target: 'b', why: 'ambas as notas são muito relacionadas entre si' }, cookieHeader),
      E
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/mechanism/i);
    const count = await E.DB.prepare('SELECT COUNT(*) c FROM edges').first();
    expect(count.c).toBe(0);
  });

  it('why substantivo (nomeia o mecanismo) segue criando a edge normalmente (regressão)', async () => {
    const cookieHeader = await cookie();
    const res = await handleGraphLink(
      linkReq({ source: 'a', target: 'b', why: 'ambas usam feedback loop atrasado, então oscilam' }, cookieHeader),
      E
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();
    const row = await E.DB.prepare('SELECT * FROM edges').first();
    expect(row.from_id).toBe('a');
    expect(row.to_id).toBe('b');
    expect(row.why).toBe('ambas usam feedback loop atrasado, então oscilam');
  });

  it('why curto (<20 chars) continua rejeitado (régua de tamanho preservada)', async () => {
    const cookieHeader = await cookie();
    const res = await handleGraphLink(
      linkReq({ source: 'a', target: 'b', why: 'curto' }, cookieHeader),
      E
    );
    expect(res.status).toBe(400);
    const count = await E.DB.prepare('SELECT COUNT(*) c FROM edges').first();
    expect(count.c).toBe(0);
  });
});
