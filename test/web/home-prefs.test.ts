import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { sanitizeHomePrefs, HOME_BOX_MIN, HOME_BOX_MAX, HOME_PREFS_META_KEY } from '../../src/web/home-prefs.js';

// Alturas das caixas da home (Onda 9, specs/60-ux-reforma/71): sanitize puro +
// endpoint POST /app/home/prefs + reflexo no SSR da home (style com a custom
// property --home-card-h só nas caixas com valor salvo).

const E = env as any;

beforeAll(async () => {
  await runMigrations(E);
});

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('sanitizeHomePrefs (spec 71)', () => {
  it('não-objeto e shape sem heights → null', () => {
    expect(sanitizeHomePrefs(null)).toBeNull();
    expect(sanitizeHomePrefs('x')).toBeNull();
    expect(sanitizeHomePrefs({})).toBeNull();
    expect(sanitizeHomePrefs({ heights: 'x' })).toBeNull();
  });

  it('clampa nos limites e arredonda', () => {
    const p = sanitizeHomePrefs({ heights: { today: 10, inbox: 5000, activity: 480.6 } })!;
    expect(p.today).toBe(HOME_BOX_MIN);
    expect(p.inbox).toBe(HOME_BOX_MAX);
    expect(p.activity).toBe(481);
  });

  it('dropa chave desconhecida e valor inválido (cai no default, nunca 400)', () => {
    const p = sanitizeHomePrefs({ heights: { today: 'abc', hacker: 300, digest: 400 } })!;
    expect(p.today).toBeUndefined();
    expect((p as any).hacker).toBeUndefined();
    expect(p.digest).toBe(400);
  });
});

describe('POST /app/home/prefs + reflexo no SSR (spec 71)', () => {
  it('sem sessão → bloqueado (401 pra request JSON)', async () => {
    const res = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ heights: { today: 500 } }),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('salva, reflete no SSR da home e o default fica sem style inline', async () => {
    const ck = await cookie();
    const res = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: { today: 500 } }),
    });
    expect(res.status).toBe(200);

    const html = await (await SELF.fetch('https://x.test/app', { headers: { cookie: ck } })).text();
    // caixa com pref salva carrega o style var; as demais ficam no fallback do CSS
    expect(html).toMatch(/data-home-box="today" style="--home-card-h:500px"/);
    expect(html).toMatch(/data-home-box="inbox"(?! style)/);
    // modal presente com o slider refletindo o valor salvo
    expect(html).toContain('id="home-prefs-modal"');
    expect(html).toContain('id="home-prefs-open"');
    expect(html).toMatch(/data-box="today"[^>]*value="500"/);

    // limpar: heights vazio volta tudo pro default (chave ausente = default)
    const clear = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: {} }),
    });
    expect(clear.status).toBe(200);
    const row = await E.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(HOME_PREFS_META_KEY).first();
    expect(JSON.parse(row.value)).toEqual({ heights: {} });
  });

  it('body inválido → 400', async () => {
    const ck = await cookie();
    const bad = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const noHeights = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ nada: true }),
    });
    expect(noHeights.status).toBe(400);
  });
});
