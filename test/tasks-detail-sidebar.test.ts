import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { insertTask, insertTags, completeTask } from '../src/db/queries.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedTask(id: string, status: string = 'open') {
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'corpo', tldr: `Task ${id}`, domains: '["operations"]',
    status: status as any, due_at: null, priority: 2, created_at: 1000, updated_at: 2000,
  });
}

// O D1 de teste é COMPARTILHADO entre arquivos (isolatedStorage:false — vitest.config.ts),
// então kanban_columns pode chegar vazio ou alterado por outro arquivo que rodou antes
// (ex.: um teste de arquivamento de coluna). Reseta explicitamente pros 4 seeds padrão,
// mesmo padrão defensivo de test/kanban-web.test.ts.
async function resetKanban() {
  await E.DB.exec('DELETE FROM kanban_columns');
  const seed = E.DB.prepare(
    `INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES (?,?,?,?,?,?)`
  );
  await E.DB.batch([
    seed.bind('col_aberto', 'A fazer', null, 1, 'open', null),
    seed.bind('col_progresso', 'Em progresso', null, 2, 'in_progress', null),
    seed.bind('col_concluido', 'Concluído', null, 3, 'done', null),
    seed.bind('col_cancelado', 'Cancelado', null, 4, 'canceled', 1),
  ]);
}

async function detail(id: string): Promise<string> {
  const res = await SELF.fetch(`https://x/app/tasks/${id}`, { headers: { cookie: await cookie() } });
  expect(res.status).toBe(200);
  return res.text();
}

describe('detalhe de task — sidebar de metadados em duas colunas (spec 52)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('renderiza o grid de duas colunas com sidebar de metadados', async () => {
    await seedTask('t1');
    const html = await detail('t1');
    expect(html).toContain('task-detail-grid');
    expect(html).toContain('task-detail-main');
    expect(html).toContain('task-detail-sidebar');
  });

  it('funil de etapas no topo substitui o select de coluna: chevrons por coluna ativa, atual marcada (spec 74)', async () => {
    await seedTask('t1', 'in_progress');
    const html = await detail('t1');
    // funil presente, com um chevron clicável por coluna ativa e a atual marcada
    expect(html).toContain('data-funnel');
    expect(html).toContain('data-funnel-col="col_aberto"');
    expect(html).toContain('data-funnel-col="col_progresso"');
    expect(html).toContain('data-funnel-col="col_concluido"');
    expect(html).not.toContain('data-funnel-col="col_cancelado"'); // arquivada não vira etapa
    expect(html).toMatch(/task-funnel-step[^"]*current[^"]*"[^>]*data-funnel-col="col_progresso"/);
    // o select antigo e o botão Concluir morreram
    expect(html).not.toContain('data-field="column"');
    expect(html).not.toContain('data-complete');
  });

  it('descrição tem UM só botão de editar (lápis) e o título não tem botão Salvar (spec 74)', async () => {
    await seedTask('t1');
    const html = await detail('t1');
    expect((html.match(/data-edit-body/g) ?? []).length).toBe(1);
    expect(html).toContain('task-edit-pencil');
    expect(html).not.toContain('data-save="title"');
  });

  it('histórico de atividades aparece na sidebar quando há entradas (spec 74)', async () => {
    await seedTask('t1');
    const html = await detail('t1');
    // insertTask loga 'created' — o histórico já nasce com 1 entrada
    expect(html).toContain('task-history');
    expect(html).toContain('criou a task');
  });

  it('editor de tags expõe as tags atuais (sem dedupe:) via data-tags', async () => {
    await seedTask('t1');
    await insertTags(E, 't1', ['vip', 'projeto-x', 'dedupe:xyz']);
    const html = await detail('t1');
    expect(html).toContain('data-tags-editor');
    const m = html.match(/data-tags="([^"]*)"/);
    expect(m).not.toBeNull();
    const decoded = m![1].replace(/&quot;/g, '"');
    const tags = JSON.parse(decoded);
    expect(tags.sort()).toEqual(['projeto-x', 'vip']);
    expect(tags).not.toContain('dedupe:xyz');
  });

  it('datas Criada/Atualizada aparecem em BRT; Concluída só quando a task fechou', async () => {
    await seedTask('t1');
    let html = await detail('t1');
    expect(html).toContain('Criada');
    expect(html).toContain('Atualizada');
    expect(html).not.toContain('Concluída');

    await completeTask(E, 't1', Date.now());
    html = await detail('t1');
    expect(html).toContain('Concluída');
  });

  it('seletor único de visibilidade presente na sidebar (spec 65)', async () => {
    await seedTask('t1');
    const html = await detail('t1');
    expect(html).toContain('data-visibility');
    expect(html).toContain('<h2>Visibilidade</h2>');
    // 3 níveis no radiogroup; default do sistema = normal
    expect(html).toContain('value="private"');
    expect(html).toContain('value="normal" checked');
    expect(html).toContain('value="link"');
    // as duas seções antigas morreram
    expect(html).not.toContain('Compartilhamento público</h2>');
    expect(html).not.toContain('data-task-private-toggle');
  });

  it('não sobra select de status cru (substituído pelo select de coluna)', async () => {
    await seedTask('t1');
    const html = await detail('t1');
    expect(html).not.toContain('data-field="status"');
  });
});
