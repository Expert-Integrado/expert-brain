import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { insertTask, insertTags, deleteNote } from '../src/db/queries.js';
import { listAllTags, renameTag, deleteTag } from '../src/db/tag-admin.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedTask(id: string) {
  await insertTask(E, {
    id, title: `Task ${id}`, body: '', tldr: `Task ${id}`, domains: '["operations"]',
    status: 'open', due_at: null, priority: 2, created_at: 1000, updated_at: 2000,
  });
}

async function tagsOf(id: string): Promise<string[]> {
  const r = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = ? ORDER BY tag`).bind(id).all();
  return (r.results ?? []).map((x: any) => x.tag);
}

describe('gestão global de tags (db/tag-admin, pedido 10/07)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
  });

  it('listAllTags agrega por tag, exclui dedupe:* e notas soft-deletadas', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await seedTask('t3');
    await insertTags(E, 't1', ['vip', 'dedupe:xyz']);
    await insertTags(E, 't2', ['vip', 'blog']);
    await insertTags(E, 't3', ['fantasma']);
    await deleteNote(E, 't3');
    const tags = await listAllTags(E);
    expect(tags).toEqual([
      { tag: 'blog', count: 1 },
      { tag: 'vip', count: 2 },
    ]);
  });

  it('renameTag renomeia em massa e faz merge quando o destino já existe na mesma nota', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await insertTags(E, 't1', ['zap', 'whatsapp']); // t1 já tem o destino: merge sem violar PK
    await insertTags(E, 't2', ['zap']);
    const n = await renameTag(E, 'zap', 'whatsapp');
    expect(n).toBe(2);
    expect(await tagsOf('t1')).toEqual(['whatsapp']);
    expect(await tagsOf('t2')).toEqual(['whatsapp']);
  });

  it('renameTag normaliza destino (trim+lowercase) e rejeita origem inexistente e prefixo dedupe:', async () => {
    await seedTask('t1');
    await insertTags(E, 't1', ['blog']);
    expect(await renameTag(E, 'blog', '  Comercial ')).toBe(1);
    expect(await tagsOf('t1')).toEqual(['comercial']);
    expect(await renameTag(E, 'nao-existe', 'x')).toBeNull();
    expect(await renameTag(E, 'comercial', 'dedupe:hack')).toBeNull();
  });

  it('deleteTag remove o rótulo de todas as notas sem apagar as notas', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await insertTags(E, 't1', ['vip', 'blog']);
    await insertTags(E, 't2', ['vip']);
    expect(await deleteTag(E, 'vip')).toBe(2);
    expect(await tagsOf('t1')).toEqual(['blog']);
    expect(await tagsOf('t2')).toEqual([]);
    const alive = await E.DB.prepare(`SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL`).first();
    expect(alive.c).toBe(2);
  });

  it('POST /app/tasks/tags/rename e /delete exigem sessão e redirecionam pra seção Tags', async () => {
    await seedTask('t1');
    await insertTags(E, 't1', ['velha']);

    const anon = await SELF.fetch('https://x/app/tasks/tags/rename', {
      method: 'POST', body: new URLSearchParams({ from: 'velha', to: 'nova' }), redirect: 'manual',
    });
    expect([302, 401, 403]).toContain(anon.status); // sem sessão nunca chega no handler de escrita
    expect(await tagsOf('t1')).toEqual(['velha']);

    const ren = await SELF.fetch('https://x/app/tasks/tags/rename', {
      method: 'POST', headers: { cookie: await cookie() },
      body: new URLSearchParams({ from: 'velha', to: 'nova' }), redirect: 'manual',
    });
    expect(ren.status).toBe(302);
    expect(ren.headers.get('location')).toBe('/app/config?saved=tags#tags');
    expect(await tagsOf('t1')).toEqual(['nova']);

    const del = await SELF.fetch('https://x/app/tasks/tags/delete', {
      method: 'POST', headers: { cookie: await cookie() },
      body: new URLSearchParams({ tag: 'nova' }), redirect: 'manual',
    });
    expect(del.status).toBe(302);
    expect(await tagsOf('t1')).toEqual([]);
  });

  it('seção Tags aparece em /app/config com o vocabulário e o form de renomear', async () => {
    await seedTask('t1');
    await insertTags(E, 't1', ['minha-tag']);
    const res = await SELF.fetch('https://x/app/config', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="tags"');
    expect(html).toContain('data-tag-row="minha-tag"');
    expect(html).toContain('/app/tasks/tags/rename');
    expect(html).toContain('tag-delete-form');
  });
});
