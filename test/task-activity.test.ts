import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertTask, updateTask, insertTags, getTagsByNote,
  type TaskRow, type UpdateResult,
} from '../src/db/queries.js';
import { logTaskActivity, listTaskActivity } from '../src/db/task-activity.js';

const E = env as any;

// updateTask devolve TaskRow | 'not-found' | 'conflict' — narrow pro TaskRow (falha
// ruidosa se vier um sentinel inesperado), mesmo padrão de tasks-queries.test.ts.
function asTask(r: UpdateResult): TaskRow {
  if (typeof r === 'string') throw new Error(`expected TaskRow, got sentinel '${r}'`);
  return r;
}

describe('task activity log (migration 0019)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    // task_activity é filha de notes (ON DELETE CASCADE) — limpa as duas pra cada
    // teste partir de um estado conhecido, mesmo padrão de tasks-update-web.test.ts.
    await E.DB.exec('DELETE FROM task_activity');
    await E.DB.exec('DELETE FROM notes');
  });

  it('migration 0019 cria task_activity + índice idx_task_activity_task', async () => {
    const tbl = await E.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_activity'`
    ).first();
    expect(tbl).not.toBeNull();
    const idx = await E.DB.prepare(
      `SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name='idx_task_activity_task'`
    ).first();
    expect(idx).not.toBeNull();
    expect((idx as any).tbl_name).toBe('task_activity');
  });

  it('logTaskActivity grava e listTaskActivity lê em ordem desc (mais recente primeiro)', async () => {
    const now = Date.now();
    await insertTask(E, {
      id: 'la1', title: 'la1', body: 'b', tldr: 'la1', domains: '["operations"]',
      status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
    });
    // insertTask já loga 'created' (spec 74) — não assume o valor exato do baseline,
    // só que cresce em 2 depois das duas gravações abaixo.
    const baseline = (await listTaskActivity(E, 'la1')).length;

    await logTaskActivity(E, 'la1', 'oauth:eric@example.com', [
      { field: 'priority', old_value: 'Normal', new_value: 'Alta' },
    ]);
    await logTaskActivity(E, 'la1', null, [
      { field: 'title', old_value: 'a', new_value: 'b' },
    ]);

    const list = await listTaskActivity(E, 'la1');
    expect(list.length).toBe(baseline + 2);
    // Mais recente primeiro: a última gravada ('title') vem antes de 'priority'.
    expect(list[0]).toMatchObject({ field: 'title', actor: null, old_value: 'a', new_value: 'b' });
    expect(list[1]).toMatchObject({
      field: 'priority', actor: 'oauth:eric@example.com', old_value: 'Normal', new_value: 'Alta',
    });
  });

  it('logTaskActivity com entries vazio é no-op (não grava linha nem quebra)', async () => {
    const now = Date.now();
    await insertTask(E, {
      id: 'la2', title: 'la2', body: 'b', tldr: 'la2', domains: '["operations"]',
      status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
    });
    const baseline = (await listTaskActivity(E, 'la2')).length;
    await logTaskActivity(E, 'la2', null, []);
    expect((await listTaskActivity(E, 'la2')).length).toBe(baseline);
  });

  it('updateTask loga title+priority quando mudam; patch repetindo os valores atuais não gera entrada', async () => {
    const now = Date.now();
    await insertTask(E, {
      id: 'diff1', title: 'Titulo antigo', body: 'b', tldr: 'Titulo antigo',
      domains: '["operations"]', status: 'open', due_at: null, priority: 3,
      created_at: now, updated_at: now,
    });

    asTask(await updateTask(E, 'diff1', { title: 'Titulo novo', priority: 1 }, now + 1));
    const afterChange = await listTaskActivity(E, 'diff1');
    const changeEntries = afterChange.filter((e) => e.field === 'title' || e.field === 'priority');
    expect(changeEntries.length).toBe(2);

    const titleEntry = changeEntries.find((e) => e.field === 'title')!;
    expect(titleEntry.old_value).toBe('Titulo antigo');
    expect(titleEntry.new_value).toBe('Titulo novo');

    const prioEntry = changeEntries.find((e) => e.field === 'priority')!;
    expect(prioEntry.old_value).toBe('Normal'); // priority 3
    expect(prioEntry.new_value).toBe('Crítica'); // priority 1

    // Patch repetindo os MESMOS valores já vigentes: zero entradas novas (nenhuma
    // mudança real de fato) — só o count total não deve crescer.
    const countBefore = (await listTaskActivity(E, 'diff1')).length;
    asTask(await updateTask(E, 'diff1', { title: 'Titulo novo', priority: 1 }, now + 2));
    const countAfter = (await listTaskActivity(E, 'diff1')).length;
    expect(countAfter).toBe(countBefore);
  });

  it('updateTask: diff de tags ignora as reservadas dedupe:*', async () => {
    const now = Date.now();
    await insertTask(E, {
      id: 'tagdiff', title: 't', body: 'b', tldr: 't', domains: '["operations"]',
      status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
    });
    await insertTags(E, 'tagdiff', ['dedupe:xyz', 'alpha']);

    asTask(await updateTask(E, 'tagdiff', { tags: ['beta'] }, now + 1));

    const activity = await listTaskActivity(E, 'tagdiff');
    const tagEntry = activity.find((e) => e.field === 'tags');
    expect(tagEntry).toBeDefined();
    expect(tagEntry!.old_value).toBe('alpha'); // dedupe:xyz nunca aparece no log
    expect(tagEntry!.new_value).toBe('beta');

    // A tag reservada sobrevive de verdade na tabela (replaceTaskTagsPreservingDedupe);
    // só fica de fora do LOG, que é só pra tag visível ao dono.
    expect((await getTagsByNote(E, 'tagdiff')).sort()).toEqual(['beta', 'dedupe:xyz']);
  });

  it('falha no INSERT do log não quebra updateTask (log é best-effort)', async () => {
    const now = Date.now();
    await insertTask(E, {
      id: 'resilient', title: 'old', body: 'b', tldr: 'old', domains: '["operations"]',
      status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
    });

    // Baseline ANTES do stub: insertTask acima já gravou a entrada 'created' via
    // logTaskActivity/batch (que ainda funciona normalmente nesse ponto) — o count
    // real de partida é 1, não 0.
    const baseline = (await listTaskActivity(E, 'resilient')).length;

    // Stub temporário: só logTaskActivity usa env.DB.batch (a escrita da task usa
    // .run() direto) — isolando a falha exatamente no caminho do log, sem tocar a
    // tabela de verdade (que é compartilhada entre arquivos de teste — isolatedStorage:false).
    // Não dá pra espiar console.error aqui: o código sob teste roda dentro do isolate
    // workerd (@cloudflare/vitest-pool-workers), um global `console` diferente do
    // processo Node do test runner — vi.spyOn(console) não atravessa essa fronteira.
    // A prova de "best-effort" fica só no comportamento observável (edição não quebra,
    // log não cresce), que é o que realmente importa pro chamador.
    const originalBatch = E.DB.batch.bind(E.DB);
    E.DB.batch = async () => { throw new Error('simulated D1 failure'); };

    let updated: TaskRow;
    try {
      updated = asTask(await updateTask(E, 'resilient', { title: 'new title', priority: 2 }, now + 1));
    } finally {
      E.DB.batch = originalBatch;
    }

    // A edição REAL foi aplicada normalmente — a falha do log nunca deveria vazar.
    expect(updated!.title).toBe('new title');
    expect(updated!.priority).toBe(2);

    // E o log da EDIÇÃO realmente não foi gravado (o batch falhou de propósito) —
    // count fica igual à baseline ('created' continua sendo a única entrada).
    const activity = await listTaskActivity(E, 'resilient');
    expect(activity.length).toBe(baseline);
  });
});
