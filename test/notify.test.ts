import { describe, it, expect } from 'vitest';
import { buildDueDigest } from '../src/notify.js';
import type { TaskRow } from '../src/db/queries.js';

const NOW = 1_750_000_000_000; // "agora" fixo (Date.now() não é permitido no runner)

function task(partial: Partial<TaskRow> & { id: string; title: string }): TaskRow {
  return {
    id: partial.id, title: partial.title, body: partial.body ?? '', tldr: partial.tldr ?? partial.title,
    domains: partial.domains ?? '["operations"]', kind: 'task',
    status: partial.status ?? 'open', due_at: partial.due_at ?? null,
    priority: partial.priority ?? null, completed_at: null,
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
});
