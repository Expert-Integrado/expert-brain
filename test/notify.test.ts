import { describe, it, expect } from 'vitest';
import { buildDueDigest, buildResurfaceBlock } from '../src/notify.js';
import type { TaskRow } from '../src/db/queries.js';
import type { ResurfaceDigest } from '../src/digest/resurface.js';

const NOW = 1_750_000_000_000; // "agora" fixo (Date.now() não é permitido no runner)

function emptyDigest(): ResurfaceDigest {
  return {
    version: 1,
    generated_at: NOW,
    open_questions: [],
    stale_central_notes: [],
    cooling_contacts: [],
    contacts_degraded: false,
    inbox_pending_over_7d: null,
    inbox_url: 'https://eb.test/app/inbox',
  };
}

function task(partial: Partial<TaskRow> & { id: string; title: string }): TaskRow {
  return {
    id: partial.id, title: partial.title, body: partial.body ?? '', tldr: partial.tldr ?? partial.title,
    domains: partial.domains ?? '["operations"]', kind: 'task',
    status: partial.status ?? 'open', due_at: partial.due_at ?? null,
    priority: partial.priority ?? null, completed_at: null,
    column_id: partial.column_id ?? null,
    project_id: partial.project_id ?? null,
    created_at: NOW, updated_at: NOW,
  };
}

describe('buildDueDigest', () => {
  it('returns null when there is nothing due', () => {
    expect(buildDueDigest([], NOW)).toBeNull();
  });

  it('separates overdue from due-today and includes title + priority', () => {
    const tasks = [
      task({ id: 'a', title: 'Atrasada', due_at: NOW - 3600_000, priority: 1 }),
      task({ id: 'b', title: 'Vence mais tarde', due_at: NOW + 3600_000, priority: 2 }),
    ];
    const digest = buildDueDigest(tasks, NOW, 'https://eb.test');
    expect(digest).not.toBeNull();
    expect(digest!).toContain('Atrasadas (1)');
    expect(digest!).toContain('Vence hoje (1)');
    expect(digest!).toContain('Atrasada');
    expect(digest!).toContain('Vence mais tarde');
    expect(digest!).toContain('[P1]');
    expect(digest!).toContain('https://eb.test/app/tasks/a'); // link canônico de task
  });

  it('omits links when no workerUrl is provided', () => {
    const digest = buildDueDigest([task({ id: 'x', title: 'Sem link', due_at: NOW + 1000 })], NOW);
    expect(digest!).toContain('Sem link');
    expect(digest!).not.toContain('/app/tasks/x');
  });

  // spec 30-features/32: caps anti alert-fatigue + teto duro de 4000 chars
  // (a Bot API do Telegram rejeita > 4096 com HTTP 400 silencioso).
  describe('caps (spec 32)', () => {
    const DAY = 86_400_000;
    const overdueRecent = (n: number) =>
      Array.from({ length: n }, (_, i) => task({ id: `or${i}`, title: `Atrasada recente ${i}`, due_at: NOW - (i % 10 + 1) * DAY }));
    const dueToday = (n: number) =>
      Array.from({ length: n }, (_, i) => task({ id: `dt${i}`, title: `Hoje ${i}`, due_at: NOW + 1000 + i }));

    it('100 atrasadas + 50 de hoje => max 15 linhas/secao, rodapes e length <= 4000', () => {
      const digest = buildDueDigest([...overdueRecent(100), ...dueToday(50)], NOW, 'https://eb.test')!;
      expect(digest.length).toBeLessThanOrEqual(4000);
      // headers com TOTAL real
      expect(digest).toContain('Atrasadas (100)');
      expect(digest).toContain('Vence hoje (50)');
      // cap por secao: 15 linhas + rodape com o excedente
      expect((digest.match(/^• Atrasada recente /gm) ?? []).length).toBeLessThanOrEqual(15);
      expect((digest.match(/^• Hoje /gm) ?? []).length).toBeLessThanOrEqual(15);
      expect(digest).toContain('…e mais');
      expect(digest).toContain('/app/tasks');
    });

    it('atrasada ha 14+ dias nao vira linha, so contagem agregada', () => {
      const old = Array.from({ length: 5 }, (_, i) =>
        task({ id: `old${i}`, title: `Fossil ${i}`, due_at: NOW - (20 + i) * DAY }));
      const digest = buildDueDigest([...old, ...overdueRecent(2)], NOW, 'https://eb.test')!;
      expect(digest).toContain('Atrasadas (7)'); // total real inclui as antigas
      expect(digest).not.toContain('Fossil');
      expect(digest).toContain('5 atrasada(s) há 14+ dias');
      expect(digest).toContain('Atrasada recente 0');
    });

    it('teto duro: mesmo com titulos enormes, length <= maxChars', () => {
      const huge = Array.from({ length: 40 }, (_, i) =>
        task({ id: `h${i}`, title: `${'Titulo muito longo pra estourar o teto '.repeat(5)}${i}`, due_at: NOW - DAY }));
      const digest = buildDueDigest(huge, NOW, 'https://eb.test', { maxChars: 1000 })!;
      expect(digest.length).toBeLessThanOrEqual(1000);
      expect(digest).toContain('Atrasadas (40)');
    });

    it('volume pequeno (<= 15 por secao) lista todas, sem rodape', () => {
      const digest = buildDueDigest([...overdueRecent(3), ...dueToday(2)], NOW, 'https://eb.test')!;
      expect((digest.match(/^• /gm) ?? []).length).toBe(5);
      expect(digest).not.toContain('…e mais');
    });
  });
});

// specs/50-console-v2/64-resurfacing-digest.md, critério 3: bloco "Do seu cérebro"
// no MESMO cron/canal do digest de tasks — vazio quando não há conteúdo (nunca
// manda notificação vazia), presente com links quando há.
describe('buildResurfaceBlock', () => {
  it('digest vazio → null (sem notificação vazia)', () => {
    expect(buildResurfaceBlock(emptyDigest())).toBeNull();
  });

  it('inclui perguntas em aberto com idade e link', () => {
    const digest: ResurfaceDigest = {
      ...emptyDigest(),
      open_questions: [{ id: 'q1', title: 'Como resolvo X?', tldr: 'tldr', age_days: 47, url: 'https://eb.test/app/notes/q1' }],
    };
    const block = buildResurfaceBlock(digest)!;
    expect(block).toContain('Do seu cérebro');
    expect(block).toContain('Como resolvo X?');
    expect(block).toContain('47');
    expect(block).toContain('https://eb.test/app/notes/q1');
  });

  it('inclui nota central com grau e contato esfriando', () => {
    const digest: ResurfaceDigest = {
      ...emptyDigest(),
      stale_central_notes: [{ id: 'n1', title: 'Decisão Y', tldr: 'tldr', age_days: 95, degree: 8, url: 'https://eb.test/app/notes/n1' }],
      cooling_contacts: [{ id: 'c1', name: 'Contato Exemplo', category: 'cliente', days_since: 65, url: 'https://eb.test/app/contacts/c1' }],
    };
    const block = buildResurfaceBlock(digest)!;
    expect(block).toContain('Decisão Y');
    expect(block).toContain('8 conexões');
    expect(block).toContain('Contato Exemplo');
    expect(block).toContain('65');
  });

  it('inclui contagem de inbox quando > 0, omite quando 0/null', () => {
    const withInbox = buildResurfaceBlock({ ...emptyDigest(), inbox_pending_over_7d: 4 })!;
    expect(withInbox).toContain('4');
    expect(withInbox).toContain('/app/inbox');

    expect(buildResurfaceBlock({ ...emptyDigest(), inbox_pending_over_7d: 0 })).toBeNull();
    expect(buildResurfaceBlock({ ...emptyDigest(), inbox_pending_over_7d: null })).toBeNull();
  });
});
