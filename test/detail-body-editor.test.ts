// Campo único de corpo no detalhe de NOTA e de TASK (specs/60-ux-reforma/74):
// LEITURA por padrão (prévia renderizada + botão "Editar" discreto) em vez dos
// antigos dois blocos sempre visíveis ("Corpo/Descrição (markdown)" + "Prévia").
// Corpo vazio mostra o placeholder "Sem descrição" clicável. A textarea de edição
// continua no HTML (escondida via [hidden]) com o valor atual — é ela que o client
// (note-edit.ts/task-edit.ts) revela ao clicar em "Editar" e usa pra salvar.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { insertTask } from '../src/db/queries.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedNote(id: string, body: string) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, `Nota ${id}`, body, 'tldr da nota de teste aqui', '["operations"]', 'concept', 100, 100).run();
}

describe('detalhe de NOTA — campo único de corpo (spec 74)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('corpo com texto: view renderizada + botão Editar; textarea de edição escondida; rótulos antigos sumiram', async () => {
    await seedNote('n1', '# Título\n\num parágrafo');
    const res = await SELF.fetch('https://x/app/notes/n1', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-bodyview');
    expect(html).toContain('data-bodyedit');
    expect(html).toContain('data-edit-body');
    expect(html).toContain('data-preview');
    expect(html).toContain('<h1>Título</h1>');
    expect(html).toContain('title="Editar em markdown"');
    // a textarea de edição continua no markup (o client revela ao clicar Editar)
    expect(html).toContain('data-field="body"');
    expect(html).toContain('um parágrafo');
    // rótulos/markup antigos morreram
    expect(html).not.toContain('Corpo (markdown)');
    expect(html).not.toContain('>Prévia<');
    expect(html).not.toContain('Salvar corpo');
  });

  it('corpo vazio/só espaço: mostra o placeholder "Sem descrição" clicável', async () => {
    await seedNote('n2', '   ');
    const res = await SELF.fetch('https://x/app/notes/n2', { headers: { cookie: await cookie() } });
    const html = await res.text();
    expect(html).toContain('Sem descrição');
    expect(html).toContain('data-edit-body');
    expect(html).toContain('note-edit-preview-empty');
  });
});

describe('detalhe de TASK — campo único de corpo (spec 74)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    // Garante ao menos uma coluna ativa pro select de coluna do detalhe (não é o
    // foco deste teste, só evita depender de estado deixado por outro arquivo —
    // o D1 de teste é compartilhado entre arquivos, sem isolatedStorage).
    await E.DB.prepare(
      `INSERT OR IGNORE INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_aberto','A fazer',NULL,1,'open',NULL)`
    ).run();
  });

  async function seedTask(id: string, body: string) {
    await insertTask(E, {
      id, title: `Task ${id}`, body, tldr: `Task ${id}`, domains: '["operations"]',
      status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1,
    });
  }

  it('descrição com texto: view renderizada + lápis único de editar; textarea escondida; rótulos antigos sumiram', async () => {
    await seedTask('t1', '# Oi\n\ncorpo da task');
    const res = await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-bodyview');
    expect(html).toContain('data-bodyedit');
    expect(html).toContain('data-edit-body');
    expect(html).toContain('<h1>Oi</h1>');
    // Reforma 10/07: o botão "Editar" de cima virou UM lápis discreto no canto
    expect(html).toContain('task-edit-pencil');
    expect(html).toContain('title="Editar descrição"');
    expect(html).toContain('data-field="body"');
    expect(html).toContain('corpo da task');
    expect(html).not.toContain('Descrição (markdown)');
    expect(html).not.toContain('>Prévia<');
    expect(html).not.toContain('Salvar descrição');
  });

  it('descrição vazia: mostra o placeholder "Sem descrição"', async () => {
    await seedTask('t2', '');
    const res = await SELF.fetch('https://x/app/tasks/t2', { headers: { cookie: await cookie() } });
    const html = await res.text();
    expect(html).toContain('Sem descrição');
    expect(html).toContain('task-edit-preview-empty');
  });
});
