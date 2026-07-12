import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { internalErrorResponse } from '../../src/web/error-pages.js';

// Páginas de erro com marca (specs/91-experiencia-premium/97): navegação HTML
// que erra a URL ganha 404 com layout e caminho de volta; exceção no handler
// vira casca 5xx com id de correlação (sem stack). Requests de API/fetch (sem
// accept: text/html) continuam recebendo o texto puro de sempre — contrato
// preservado pra scripts e monitores.

const E = env as any;
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('404 com marca (spec 97 §2)', () => {
  it('navegação HTML autenticada pra rota inexistente: página com marca, volta pro /app, no-store', async () => {
    const res = await SELF.fetch('https://x.test/app/rota-que-nao-existe', {
      headers: { cookie: await authCookie(), accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain('Página não encontrada');
    expect(html).toContain('href="/app"');
    expect(html).toContain('Expert Brain');
  });

  it('request de API (sem accept html) mantém o texto puro de sempre', async () => {
    const res = await SELF.fetch('https://x.test/app/rota-que-nao-existe', {
      headers: { cookie: await authCookie(), accept: 'application/json' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await res.text()).toBe('Não encontrado');
  });
});

describe('5xx com marca (spec 97 §3)', () => {
  it('internalErrorResponse: casca HTML com id de correlação, sem stack', () => {
    const req = new Request('https://x.test/app', { headers: { accept: 'text/html' } });
    const err = new Error('segredo interno do stack');
    const res = internalErrorResponse(req, err, 'abc12345');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('casca 5xx traz o id e esconde a exceção', async () => {
    const req = new Request('https://x.test/app', { headers: { accept: 'text/html' } });
    const res = internalErrorResponse(req, new Error('segredo interno do stack'), 'abc12345');
    const html = await res.text();
    expect(html).toContain('abc12345');
    expect(html).not.toContain('segredo interno do stack');
    expect(html).toContain('href="/app"');
  });

  it('request de API recebe texto puro com o mesmo id', async () => {
    const req = new Request('https://x.test/app/x', { headers: { accept: 'application/json' } });
    const res = internalErrorResponse(req, new Error('boom'), 'id9');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await res.text()).toContain('id9');
  });
});
