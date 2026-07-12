import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';
import { wantsJson, formError, formErrorBanner } from './form-error.js';

// Spec 91-experiencia-premium/94: erro de form NUNCA vira página de texto puro.
// Client moderno (accept: application/json, via appFetch) recebe JSON {ok,error,field};
// fallback sem JS recebe 303 de volta pra página de origem com ?error= (banner).

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  (env as any).OWNER_EMAIL = 'owner@example.com';
  (env as any).SESSION_SECRET = SECRET;
  await runMigrations(env as any);
});

const jsonReq = (url = 'https://x.test/app/config/users/create'): Request =>
  new Request(url, { method: 'POST', headers: { accept: 'application/json' } });

const browserReq = (referer?: string): Request =>
  new Request('https://x.test/app/config/users/create', {
    method: 'POST',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      ...(referer ? { referer } : {}),
    },
  });

describe('wantsJson', () => {
  it('true pro accept do appFetch, false pro accept de navegação do browser', () => {
    expect(wantsJson(jsonReq())).toBe(true);
    expect(wantsJson(browserReq())).toBe(false);
  });
});

describe('formError', () => {
  it('client moderno: JSON { ok:false, error, field } com o status pedido', async () => {
    const res = formError(jsonReq(), 'Nome obrigatório', { field: 'name' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = await res.json() as any;
    expect(body).toEqual({ ok: false, error: 'Nome obrigatório', field: 'name' });
  });

  it('status customizado e field ausente viram 413/null', async () => {
    const res = formError(jsonReq(), 'Foto grande demais', { status: 413 });
    expect(res.status).toBe(413);
    const body = await res.json() as any;
    expect(body.field).toBeNull();
  });

  it('fallback sem JS: 303 de volta pro referer same-origin com ?error=', () => {
    const res = formError(browserReq('https://x.test/app/config?saved=users'), 'Nome obrigatório');
    expect(res.status).toBe(303);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('/app/config')).toBe(true);
    const u = new URL(loc, 'https://x.test');
    expect(u.searchParams.get('error')).toBe('Nome obrigatório');
    expect(u.searchParams.get('saved')).toBe('users');
  });

  it('fallback substitui ?error= anterior em vez de acumular', () => {
    const res = formError(browserReq('https://x.test/app/config?error=Velho'), 'Novo erro');
    const u = new URL(res.headers.get('location')!, 'https://x.test');
    expect(u.searchParams.getAll('error')).toEqual(['Novo erro']);
  });

  it('referer cross-origin é ignorado: cai no returnTo (com hash preservado)', () => {
    const res = formError(browserReq('https://evil.example/app/config'), 'Erro', {
      returnTo: '/app/config#users',
    });
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('/app/config')).toBe(true);
    expect(loc).toContain('error=');
    expect(loc.endsWith('#users')).toBe(true);
  });

  it('sem referer e sem returnTo cai em /app', () => {
    const res = formError(browserReq(), 'Erro');
    expect(res.headers.get('location')!.startsWith('/app?')).toBe(true);
  });
});

describe('formErrorBanner', () => {
  it('renderiza o banner escapado quando há ?error=', () => {
    const html = formErrorBanner(new URL('https://x.test/app/config?error=' + encodeURIComponent('Nome <b>x</b>')));
    expect(html).toContain('callout-error');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Nome &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('vazio sem ?error= e capa mensagens gigantes', () => {
    expect(formErrorBanner(new URL('https://x.test/app/config'))).toBe('');
    const long = 'x'.repeat(2000);
    const html = formErrorBanner(new URL(`https://x.test/app/config?error=${long}`));
    expect(html.length).toBeLessThan(600);
  });
});

describe('handlers migrados (fim-a-fim via SELF)', () => {
  it('users/create sem nome: JSON 400 com field name (client moderno)', async () => {
    const form = new FormData();
    form.set('name', '');
    form.set('type', 'agent');
    const res = await SELF.fetch('https://x.test/app/config/users/create', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.field).toBe('name');
    expect(body.error).toContain('Nome');
  });

  it('users/create sem nome: browser volta 303 com ?error= (nunca texto puro)', async () => {
    const form = new FormData();
    form.set('name', '');
    form.set('type', 'agent');
    const res = await SELF.fetch('https://x.test/app/config/users/create', {
      method: 'POST',
      headers: {
        cookie: await authCookie(),
        accept: 'text/html,application/xhtml+xml',
        referer: 'https://x.test/app/config',
      },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('error=');
  });

  it('api-keys/create sem dono: JSON 400 com field user_id', async () => {
    const form = new FormData();
    form.set('name', 'chave de teste');
    const res = await SELF.fetch('https://x.test/app/api-keys/create', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.field).toBe('user_id');
  });

  it('config/prefs com prompt vazio: JSON 400 com field prompt', async () => {
    const form = new FormData();
    form.set('prompt', '   ');
    const res = await SELF.fetch('https://x.test/app/config/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.field).toBe('prompt');
  });

  it('coluna do board com nome longo: JSON 400 com field label', async () => {
    const form = new FormData();
    form.set('label', 'x'.repeat(50));
    const res = await SELF.fetch('https://x.test/app/tasks/columns/create', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.field).toBe('label');
  });

  it('página do config renderiza o banner quando chega com ?error=', async () => {
    const res = await SELF.fetch('https://x.test/app/config?error=Nome+inválido', {
      headers: { cookie: await authCookie() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('callout-error');
    expect(html).toContain('Nome inválido');
  });
});
