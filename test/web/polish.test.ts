import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { NEBULA_CSS } from '../../src/web/styles.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

describe('/app/styles.css externo cacheável (spec 28)', () => {
  it('200 text/css immutable, corpo é o NEBULA_CSS; público (sem sessão)', async () => {
    const res = await SELF.fetch('https://x.test/app/styles.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const body = await res.text();
    expect(body).toBe(NEBULA_CSS);
  });

  it('páginas do app usam <link rel=stylesheet> e NÃO embutem o <style> do tema', async () => {
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="/app/styles.css?v=');
    // O bloco <style> gigante do tema não vai mais inline (só extraHead pequeno pode existir).
    expect(html).not.toContain(NEBULA_CSS.slice(0, 200));
  });
});

describe('/app/config/bundle.js versionado + immutable (spec 28)', () => {
  it('resposta immutable e a página referencia ?v=<hash>', async () => {
    const res = await SELF.fetch('https://x.test/app/config/bundle.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const page = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await authCookie() } });
    const html = await page.text();
    expect(html).toMatch(/\/app\/config\/bundle\.js\?v=[0-9a-f]{12}/);
  });
});

// serveBundle (env.ASSETS.fetch) não é exercitável neste harness — o binding ASSETS
// não existe no miniflare de teste (só D1/KV/R2). A lógica r.ok → immutable / senão
// no-store é validada no navegador (prova manual da spec 28) + code review. O caminho
// immutable pra recurso servido DIRETO do módulo (config/bundle.js, styles.css) já
// está coberto acima, que é o mesmo racional de header.

describe('kanban SSR — link canônico /app/tasks/<id> (spec 28)', () => {
  beforeAll(async () => {
    await E.DB.prepare(`DELETE FROM notes`).run();
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,status) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind('tk1', 'Minha task de teste', 'b', 'tl', '["product"]', 'task', 1, 1, 'open').run();
  });

  it('cards SSR linkam /app/tasks/<id> e nenhum /app/notes/<id> em renderCardSSR', async () => {
    const res = await SELF.fetch('https://x.test/app/tasks', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/app/tasks/tk1"');
    // O card não deve mais apontar pra /app/notes/<id> (evita o 302 extra).
    expect(html).not.toContain('href="/app/notes/tk1"');
  });
});
