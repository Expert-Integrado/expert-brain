// Testes do helper de fetch dos clients (src/web/client/http.ts) — camada
// client em jsdom (specs/60-ux-reforma/61). Cobre o header accept e o
// redirect+throw em 401 (anti "sucesso falso").
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appFetch } from '../../src/web/client/http.js';

const realFetch = globalThis.fetch;

describe('appFetch', () => {
  beforeEach(() => {
    // jsdom não deixa reatribuir location.href cross-origin — espiona via stub
    // do objeto location inteiro.
    const loc = { ...window.location, href: 'http://localhost/app/tasks', pathname: '/app/tasks', search: '' };
    Object.defineProperty(window, 'location', { value: loc, writable: true, configurable: true });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('seta accept: application/json quando o caller não setou', async () => {
    let seen: Headers | undefined;
    globalThis.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.headers as Headers;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await appFetch('/app/tasks/data');
    expect(seen?.get('accept')).toBe('application/json');
  });

  it('preserva accept custom do caller', async () => {
    let seen: Headers | undefined;
    globalThis.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.headers as Headers;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    await appFetch('/app/export', { headers: { accept: 'text/csv' } });
    expect(seen?.get('accept')).toBe('text/csv');
  });

  it('em 401 redireciona pro login com next e lança', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 })) as typeof fetch;
    await expect(appFetch('/app/tasks/data')).rejects.toThrow('session expired');
    expect(window.location.href).toBe('/app/login?next=' + encodeURIComponent('/app/tasks'));
  });

  it('devolve a resposta intacta em não-401', async () => {
    globalThis.fetch = vi.fn(async () => new Response('erro', { status: 500 })) as typeof fetch;
    const res = await appFetch('/x');
    expect(res.status).toBe(500);
  });
});
