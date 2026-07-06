import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { renderTodayCard, renderInboxCard } from '../../src/web/home.js';
import type { TaskRow, InboxItem } from '../../src/db/queries.js';

// Home "Hoje" (specs/50-console-v2/65-home-hoje-e-journal.md §2). As funções de
// render dos cards "Hoje"/"Inbox" são testadas ISOLADAS (sem D1/HTTP) — o banco de
// teste é compartilhado entre TODOS os arquivos (isolatedStorage:false), então
// contar tasks/inbox "devidas hoje" globalmente via HTTP seria frágil (outros
// arquivos deixam tasks com due_at próximo). O smoke test HTTP no fim cobre só o
// que É estável entre suítes: gate de sessão, shell/nav e o skeleton assíncrono.

const E = env as any;

beforeAll(async () => {
  await runMigrations(E);
});

function fakeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't1', title: 'Task de teste', body: 'corpo', tldr: 'tldr', domains: '["operations"]',
    kind: 'task', status: 'open', due_at: null, priority: null, completed_at: null,
    column_id: null, project_id: null, created_at: 0, updated_at: 0,
    ...overrides,
  };
}

function fakeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'ibx_1', body: 'captura crua', source: 'console',
    created_at: 0, triaged_at: null, triage_action: null, result_id: null,
    ...overrides,
  };
}

describe('renderTodayCard (spec 65 §2, card "Hoje")', () => {
  it('lista vazia → estado vazio, sem <ul>', () => {
    const html = renderTodayCard([], Date.now());
    expect(html).toContain('Nada vencendo nas próximas 24h');
    expect(html).not.toContain('home-today-list');
  });

  it('task com due_at → botão quick-complete com data-id + link pro detalhe', () => {
    const now = 1_000_000;
    const html = renderTodayCard([fakeTask({ id: 'tk1', title: 'Ligar pro cliente', due_at: now + 3600_000 })], now);
    expect(html).toContain('data-id="tk1"');
    expect(html).toContain('class="home-task-complete"');
    expect(html).toContain('href="/app/tasks/tk1"');
    expect(html).toContain('Ligar pro cliente');
  });

  it('task privada → badge de privacidade', () => {
    const html = renderTodayCard([fakeTask({ id: 'tkpriv', private: 1 })], Date.now());
    expect(html).toContain('home-private-badge');
  });

  it('task vencida (overdue) → classe overdue no "quando"', () => {
    const now = 1_000_000;
    const html = renderTodayCard([fakeTask({ id: 'tkover', due_at: now - 3600_000 })], now);
    expect(html).toContain('home-task-when overdue');
  });

  it('escapa título com HTML (XSS)', () => {
    const html = renderTodayCard([fakeTask({ id: 'tkxss', title: '<script>alert(1)</script>' })], Date.now());
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderInboxCard (spec 65 §2, card "Inbox")', () => {
  it('pending=0 → estado vazio', () => {
    const html = renderInboxCard(0, []);
    expect(html).toContain('Inbox vazio');
  });

  it('mostra contagem e os 3 MAIS RECENTES (fim da lista ASC, invertidos)', () => {
    const items = [
      fakeInboxItem({ id: 'i1', body: 'primeiro capturado' }),
      fakeInboxItem({ id: 'i2', body: 'segundo capturado' }),
      fakeInboxItem({ id: 'i3', body: 'terceiro capturado' }),
      fakeInboxItem({ id: 'i4', body: 'quarto capturado (mais recente)' }),
    ];
    const html = renderInboxCard(4, items);
    expect(html).toContain('4 pendentes');
    expect(html).toContain('quarto capturado');
    expect(html).toContain('terceiro capturado');
    expect(html).toContain('segundo capturado');
    expect(html).not.toContain('primeiro capturado');
    // Mais recente (i4) aparece ANTES do i2 na ordem de exibição.
    expect(html.indexOf('quarto capturado')).toBeLessThan(html.indexOf('segundo capturado'));
  });

  it('trunca a primeira linha longa do corpo cru', () => {
    const longBody = 'x'.repeat(200);
    const html = renderInboxCard(1, [fakeInboxItem({ body: longBody })]);
    expect(html).toContain('…');
    expect(html).not.toContain('x'.repeat(150));
  });
});

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('GET /app — home (spec 65 §2, smoke)', () => {
  it('sem sessão → 302', async () => {
    const res = await SELF.fetch('https://x.test/app', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('com sessão → 200, shell com nav "Início" ativa, skeleton assíncrono de interações', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('>Início<');
    expect(html).toContain('nav-item active');
    expect(html).toContain('id="home-events-list"');
    expect(html).toContain('/app/home/bundle.js');
    expect(html).toContain('journal completo');
  });

  it('/app/ (com barra) também renderiza a home', async () => {
    const res = await SELF.fetch('https://x.test/app/', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="home-events-list"');
  });
});
