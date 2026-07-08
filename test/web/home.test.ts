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

describe('renderInboxCard (spec 65 §2 + Onda 8/spec 70: captura e triagem na home)', () => {
  it('pending=0 → estado vazio, mas o form de captura SEMPRE aparece (inbox saiu do menu)', () => {
    const html = renderInboxCard(0, []);
    expect(html).toContain('Inbox vazio');
    expect(html).toContain('action="/app/inbox/add"');
    expect(html).toContain('name="next" value="/app"');
  });

  it('mostra contagem, itens mais recentes primeiro e triagem inline por item', () => {
    const items = [
      fakeInboxItem({ id: 'i1', body: 'primeiro capturado' }),
      fakeInboxItem({ id: 'i2', body: 'segundo capturado' }),
      fakeInboxItem({ id: 'i3', body: 'terceiro capturado' }),
      fakeInboxItem({ id: 'i4', body: 'quarto capturado (mais recente)' }),
    ];
    const html = renderInboxCard(4, items);
    expect(html).toContain('4 pendentes');
    // Todos aparecem (cap de 20, Onda 8) — o scroll interno do card segura a altura.
    for (const t of ['primeiro capturado', 'segundo capturado', 'terceiro capturado', 'quarto capturado']) {
      expect(html).toContain(t);
    }
    // Mais recente (i4) aparece ANTES do i1 na ordem de exibição.
    expect(html.indexOf('quarto capturado')).toBeLessThan(html.indexOf('primeiro capturado'));
    // Triagem inline: nota / tarefa / descartar via endpoints do inbox, id no hidden.
    expect(html).toContain('action="/app/inbox/to-note"');
    expect(html).toContain('action="/app/inbox/to-task"');
    expect(html).toContain('action="/app/inbox/resolve"');
    expect(html).toContain('name="id" value="i4"');
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

  it('com sessão → 200, shell com nav "Início" ativa, feed "Atividade" lazy (spec 69)', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('>Início<');
    expect(html).toContain('nav-item active');
    // Feed de atividade absorvido do /app/journal: container lazy + filtros + bundle.
    expect(html).toContain('id="journal-groups" data-lazy="1"');
    expect(html).toContain('journal-filter');
    expect(html).toContain('/app/home/bundle.js');
    expect(html).toContain('/app/journal/bundle.js');
    // Journal saiu da navegação (sidebar e bottom-nav) — o feed mora na home.
    expect(html).not.toContain('href="/app/journal"');
  });

  it('/app/ (com barra) também renderiza a home', async () => {
    const res = await SELF.fetch('https://x.test/app/', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="journal-groups"');
  });
});
