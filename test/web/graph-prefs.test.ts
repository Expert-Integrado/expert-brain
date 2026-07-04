import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// Spec 29 — prefs por SUPERFÍCIE (notas ≠ contatos) + boot sempre 2D.

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function metaValue(key: string): Promise<string | null> {
  const row = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first();
  return row?.value ?? null;
}

const basePrefs = {
  forces: { center: 0.3, repel: 5, link: 0.5, distance: 100 },
  colorMode: 'domain',
  similarOpacity: 0.4,
};

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

describe('POST /app/graph/prefs por superfície (spec 29)', () => {
  it('surface contacts grava na chave própria, sem tocar a legada', async () => {
    await E.DB.prepare(`DELETE FROM meta WHERE key LIKE 'graph_prefs%'`).run();
    const res = await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...basePrefs, surface: 'contacts' }),
    });
    expect(res.status).toBe(200);
    expect(await metaValue('graph_prefs:contacts')).toContain('"colorMode":"domain"');
    expect(await metaValue('graph_prefs')).toBeNull();
  });

  it('sem surface (ou notes) grava na chave legada — zero migração pra notas', async () => {
    await E.DB.prepare(`DELETE FROM meta WHERE key LIKE 'graph_prefs%'`).run();
    const res = await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify(basePrefs),
    });
    expect(res.status).toBe(200);
    expect(await metaValue('graph_prefs')).toContain('"colorMode":"domain"');
    expect(await metaValue('graph_prefs:contacts')).toBeNull();
  });

  it('mode NÃO é mais persistido (sanitize dropa)', async () => {
    await E.DB.prepare(`DELETE FROM meta WHERE key LIKE 'graph_prefs%'`).run();
    await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...basePrefs, mode: '3d' }),
    });
    const saved = await metaValue('graph_prefs');
    expect(saved).not.toBeNull();
    expect(saved).not.toContain('"mode"');
  });
});

describe('leitura por superfície nas páginas', () => {
  it('contacts sem chave própria HERDA a legada (fallback); com chave própria, usa a sua', async () => {
    await E.DB.prepare(`DELETE FROM meta WHERE key LIKE 'graph_prefs%'`).run();
    // Só a legada existe (similarOpacity 0.4)
    await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify(basePrefs),
    });
    let page = await SELF.fetch('https://x.test/app/contacts', { headers: { cookie: await authCookie() } });
    let html = await page.text();
    expect(html).toContain('&quot;similarOpacity&quot;:0.4');

    // Agora contacts salva a própria (similarOpacity 0.9) — notas continua 0.4
    await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...basePrefs, similarOpacity: 0.9, surface: 'contacts' }),
    });
    page = await SELF.fetch('https://x.test/app/contacts', { headers: { cookie: await authCookie() } });
    html = await page.text();
    expect(html).toContain('&quot;similarOpacity&quot;:0.9');

    const notesPage = await SELF.fetch('https://x.test/app/graph', { headers: { cookie: await authCookie() } });
    const notesHtml = await notesPage.text();
    expect(notesHtml).toContain('&quot;similarOpacity&quot;:0.4');
  });
});

describe('boot SEMPRE 2D (spec 29)', () => {
  it('pref antiga com mode 3d NÃO prende o boot — /app/graph abre em 2D', async () => {
    // Blob legado gravado DIRETO no meta com mode: '3d' (estado que prendia o boot).
    await E.DB.prepare(
      `INSERT INTO meta (key, value) VALUES ('graph_prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(JSON.stringify({ ...basePrefs, mode: '3d' })).run();
    const page = await SELF.fetch('https://x.test/app/graph', { headers: { cookie: await authCookie() } });
    const html = await page.text();
    expect(html).toContain('data-graph-initial-mode="2d"');
  });

  it('?mode=3d explícito na URL continua abrindo em 3D (deep-link)', async () => {
    const page = await SELF.fetch('https://x.test/app/graph?mode=3d', { headers: { cookie: await authCookie() } });
    const html = await page.text();
    expect(html).toContain('data-graph-initial-mode="3d"');
  });

  it('contatos nunca abre em 3D, mesmo com ?mode=3d', async () => {
    const page = await SELF.fetch('https://x.test/app/contacts?mode=3d', { headers: { cookie: await authCookie() } });
    const html = await page.text();
    expect(html).toContain('data-graph-initial-mode="2d"');
  });
});
