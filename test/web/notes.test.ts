import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function countMatches(html: string, needle: RegExp): number {
  return (html.match(needle) ?? []).length;
}

// 250 notas de conhecimento + 5 tasks (que NÃO devem aparecer), updated_at crescente.
beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  E.GRAPH_EXPORT_TOKEN = 'tok';
  await runMigrations(E);
  await E.DB.prepare(`DELETE FROM notes`).run();
  await E.DB.prepare(`DELETE FROM edges`).run();
  await E.DB.prepare(`DELETE FROM similar_edges`).run();

  const CHUNK = 100;
  for (let base = 0; base < 250; base += CHUNK) {
    const stmts: any[] = [];
    for (let i = base; i < Math.min(base + CHUNK, 250); i++) {
      stmts.push(E.DB.prepare(
        `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
      ).bind(`p${String(i).padStart(4, '0')}`, `Nota ${i}`, 'body', 'tldr aqui', '["product"]', 'concept', i + 1, i + 1));
    }
    await E.DB.batch(stmts);
  }
  // 5 tasks — excluídas de /app/notes e do meta.
  const tstmts: any[] = [];
  for (let i = 0; i < 5; i++) {
    tstmts.push(E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,status) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(`t${i}`, `Task ${i}`, 'b', 'tl', '["product"]', 'task', 1000 + i, 1000 + i, 'open'));
  }
  await E.DB.batch(tstmts);
});

describe('/app/notes — paginação SSR (spec 23)', () => {
  it('primeira página: ≤100 note-card + link notes-load-more com offset=100', async () => {
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(countMatches(html, /class="note-card"/g)).toBe(100);
    expect(html).toContain('id="notes-load-more"');
    expect(html).toContain('href="/app/notes?offset=100"');
    // Contador mostra o TOTAL (250), não o tamanho da página. Tasks não contam.
    expect(html).toContain('>250 notas<');
    // Task não vaza pra lista de notas.
    expect(html).not.toContain('Task 0');
  });

  it('segunda página (offset=100): cards 101–200, contador ainda mostra total', async () => {
    const res = await SELF.fetch('https://x.test/app/notes?offset=100', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(countMatches(html, /class="note-card"/g)).toBe(100);
    // updated_at desc: as maiores primeiro. Página 2 começa na 150ª maior (i=149..50).
    expect(html).toContain('>Nota 149<'); // topo da página 2
    expect(html).toContain('href="/app/notes?offset=200"');
    expect(html).toContain('>250 notas<');
  });

  it('offset inválido (negativo / não-numérico) → tratado como 0, sem 500', async () => {
    for (const bad of ['-5', 'abc', 'NaN', '']) {
      const res = await SELF.fetch(`https://x.test/app/notes?offset=${bad}`, { headers: { cookie: await authCookie() } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(countMatches(html, /class="note-card"/g)).toBe(100);
    }
  });

  it('offset além do fim → página vazia com link de volta ao início (não empty-state)', async () => {
    const res = await SELF.fetch('https://x.test/app/notes?offset=1000', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(countMatches(html, /class="note-card"/g)).toBe(0);
    expect(html).toContain('Voltar pro início');
    expect(html).toContain('>250 notas<'); // total continua correto
    // NÃO é o empty-state de vault vazio.
    expect(html).not.toContain('Nenhuma nota ainda');
  });
});

describe('/app/graph/meta — ETag + 304 + updated_at (spec 23)', () => {
  const bearer = { Authorization: 'Bearer tok' };

  it('responde etag + cache-control private/max-age e inclui updated_at', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/meta', { headers: bearer });
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(etag).toContain('meta-');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    const meta = await res.json() as any[];
    expect(meta.length).toBe(250); // tasks fora
    expect(typeof meta[0].updated_at).toBe('number');
    expect(meta[0].updated_at).toBeGreaterThan(0);
  });

  it('If-None-Match igual → 304 sem corpo; após update de nota → 200 com hash novo', async () => {
    const r1 = await SELF.fetch('https://x.test/app/graph/meta', { headers: bearer });
    const etag = r1.headers.get('etag')!;
    await r1.text();

    const r2 = await SELF.fetch('https://x.test/app/graph/meta', { headers: { ...bearer, 'If-None-Match': etag } });
    expect(r2.status).toBe(304);
    expect((await r2.text()).length).toBe(0);

    // Editar uma nota muda MAX(updated_at)/hash → 200 (não 304 stale).
    await E.DB.prepare(`UPDATE notes SET updated_at = 999999 WHERE id = 'p0000'`).run();
    const r3 = await SELF.fetch('https://x.test/app/graph/meta', { headers: { ...bearer, 'If-None-Match': etag } });
    expect(r3.status).toBe(200);
    expect(r3.headers.get('etag')).not.toBe(etag);
  });
});
