import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { renderStartHereCard, getActivationState, type ActivationState } from '../../src/web/home.js';
import { getHomePrefs } from '../../src/web/home-prefs.js';

// Onboarding e ativação (specs/91-experiencia-premium/92): card "Comece aqui" na
// home com 4 passos DERIVADOS dos dados (sem tabela nova) + empty states guiados
// nas telas-núcleo. O banco de teste é compartilhado (isolatedStorage:false) —
// cada describe zera as tabelas de que depende, mesmo padrão de users-web.test.ts.

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

const allPending: ActivationState = { agent: false, note: false, install: false, task: false };
const allDone: ActivationState = { agent: true, note: true, install: true, task: true };

describe('renderStartHereCard (spec 92 §1)', () => {
  it('4 passos pendentes: card com os 4 CTAs e nenhum check', () => {
    const html = renderStartHereCard(allPending, 'https://brain.example');
    expect(html).toContain('Comece aqui');
    expect(html).toContain('/app/config#api-keys');
    expect(html).toContain('data-cmd-open');
    expect(html).toContain('/app/config#pwa-install');
    expect(html).toContain('/app/tasks');
    expect(html).toContain('claude mcp add');
    expect(html).toContain('https://brain.example/mcp');
    expect(html).not.toContain('start-step-done');
  });

  it('passo concluído ganha check; card some quando os 4 completam', () => {
    const half = renderStartHereCard({ ...allPending, agent: true, note: true }, 'https://x');
    expect(half.split('start-step-done').length - 1).toBe(2);
    expect(renderStartHereCard(allDone, 'https://x')).toBe('');
  });
});

describe('getActivationState — derivado dos dados (spec 92 §1)', () => {
  beforeEach(async () => {
    await E.DB.exec('DELETE FROM api_keys');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.exec('DELETE FROM push_subscriptions');
  });

  it('vault zerado: tudo pendente', async () => {
    expect(await getActivationState(E)).toEqual(allPending);
  });

  it('cada fonte liga o seu passo', async () => {
    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at, last_used_at) VALUES ('k1', 'owner@example.com', 'agente', 'eb_', 'h', 1, 2)`
    ).run();
    await E.DB.prepare(
      `INSERT INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at) VALUES ('n1', 'nota', 'b', 't', '["operations"]', 'insight', 1, 1)`
    ).run();
    await E.DB.prepare(
      `INSERT INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at) VALUES ('t1', 'task', 'b', 't', '["operations"]', 'task', 1, 1)`
    ).run();
    await E.DB.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES ('ps1', 'e', 'p', 'a', 1)`
    ).run();
    expect(await getActivationState(E)).toEqual(allDone);
  });

  it('chave sem uso e nota deletada NÃO contam', async () => {
    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES ('k1', 'owner@example.com', 'agente', 'eb_', 'h', 1)`
    ).run();
    await E.DB.prepare(
      `INSERT INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at, deleted_at) VALUES ('n1', 'nota', 'b', 't', '[]', 'insight', 1, 1, 9)`
    ).run();
    expect(await getActivationState(E)).toEqual(allPending);
  });
});

describe('home + dismiss (spec 92 §1)', () => {
  beforeEach(async () => {
    await E.DB.exec('DELETE FROM api_keys');
    await E.DB.exec('DELETE FROM push_subscriptions');
    await E.DB.exec(`DELETE FROM meta WHERE key = 'home_prefs'`);
  });

  it('com passos pendentes a home mostra o card; dismiss persiste e esconde', async () => {
    const ck = await authCookie();
    const before = await SELF.fetch('https://x.test/app', { headers: { cookie: ck } });
    expect(await before.text()).toContain('id="start-here"');

    const dismiss = await SELF.fetch('https://x.test/app/home/start-dismiss', {
      method: 'POST',
      headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
    });
    expect(dismiss.status).toBe(302);
    expect((await getHomePrefs(E)).startDismissed).toBe(true);

    const after = await SELF.fetch('https://x.test/app', { headers: { cookie: ck } });
    expect(await after.text()).not.toContain('id="start-here"');
  });

  it('salvar layout das caixas NÃO apaga o dismiss', async () => {
    const ck = await authCookie();
    await SELF.fetch('https://x.test/app/home/start-dismiss', {
      method: 'POST', headers: { cookie: ck }, body: '', redirect: 'manual',
    });
    const save = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { cookie: ck, 'content-type': 'application/json' },
      body: JSON.stringify({ heights: { today: 300 } }),
    });
    expect(save.status).toBe(200);
    expect((await getHomePrefs(E)).startDismissed).toBe(true);
  });
});

describe('empty states guiados (spec 92 §2)', () => {
  it('/app/notes sem notas: .empty-state com CTA de criação (nada de parágrafo cru)', async () => {
    await E.DB.exec('DELETE FROM notes');
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('empty-state');
    expect(html).toContain('data-click-proxy="notes-new-btn"');
    expect(html).not.toContain('<p style="color:var(--text-dim)">Nenhuma nota ainda.</p>');
  });

  it('/app/tasks sem tasks: .empty-state com CTA de criação', async () => {
    await E.DB.exec(`DELETE FROM notes WHERE kind = 'task'`);
    const res = await SELF.fetch('https://x.test/app/tasks', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('empty-state');
    expect(html).toContain('data-click-proxy="task-new-btn"');
  });
});
