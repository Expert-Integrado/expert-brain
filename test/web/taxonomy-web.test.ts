// Integração ponta-a-ponta da taxonomia configurável (spec 54): cobre as
// superfícies SSR (config, notas, notas-lista) que o teste unitário de
// taxonomy-config.test.ts não alcança. Os bundles CLIENT (client/graph.ts,
// client/notes.ts) fazem o mesmo trabalho de resolução via fetch, mas o repo
// não tem harness de DOM/jsdom pra bundle client — cobertos por typecheck +
// pelo fato de consumirem os MESMOS resolvers já testados em domain-colors.test.ts.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { getNoteById } from '../../src/db/queries.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedNote(id: string, domains: string[], updatedAt = 1000) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'concept', NULL, NULL, NULL, NULL, ?, ?, NULL)`
  ).bind(id, `Nota ${id}`, 'corpo', 'tldr da nota aqui original', JSON.stringify(domains), updatedAt, updatedAt).run();
}

beforeEach(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
  await E.DB.prepare(`DELETE FROM meta WHERE key = 'taxonomy_config'`).run();
});

describe('/app/config — seção "Áreas e tipos" (spec 54)', () => {
  it('mostra os 12 canônicos com o slug em <code> e os 7 kinds fixos', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Áreas e tipos');
    expect(html).toContain('<code>management</code>');
    expect(html).toContain('<code>concept</code>');
    expect(html).toContain('taxonomy-domains-body');
    expect(html).toContain('taxonomy-kinds-body');
  });

  it('área pré-criada pela config (0 notas): aparece na tabela com label/cor customizados e contagem 0', async () => {
    const post = await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { 'vida-pessoal': { label: 'Vida Pessoal', color: '#22c55e' } }, kinds: {} }),
    });
    expect(post.status).toBe(200);

    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('<code>vida-pessoal</code>');
    expect(html).toContain('value="Vida Pessoal"');
    expect(html).toContain('value="#22c55e"');
    // Linha da área pré-criada tem 0 na coluna de contagem.
    const rowMatch = html.match(/<tr data-slug="vida-pessoal">[\s\S]*?<\/tr>/);
    expect(rowMatch).toBeTruthy();
    expect(rowMatch![0]).toMatch(/<td>0<\/td>/);
  });

  it('cor/label customizados de uma área EM USO refletem na tabela junto com a contagem real', async () => {
    await E.DB.prepare(`DELETE FROM notes WHERE id LIKE 'taxweb-%'`).run();
    await seedNote('taxweb-1', ['sales']);
    await seedNote('taxweb-2', ['sales', 'marketing']);
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { sales: { label: 'Vendas', color: '#00ff00' } }, kinds: {} }),
    });
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    const rowMatch = html.match(/<tr data-slug="sales">[\s\S]*?<\/tr>/);
    expect(rowMatch).toBeTruthy();
    expect(rowMatch![0]).toContain('value="Vendas"');
    expect(rowMatch![0]).toContain('value="#00ff00"');
    expect(rowMatch![0]).toMatch(/<td>2<\/td>/); // 2 notas usam 'sales'
  });

  it('task NUNCA soma na contagem da tabela de áreas (isolamento — spec 54)', async () => {
    await E.DB.prepare(`DELETE FROM notes WHERE id LIKE 'taxweb-iso-%'`).run();
    await seedNote('taxweb-iso-1', ['product']);
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
       VALUES ('taxweb-iso-task','Task iso','b','Task iso aqui','["product"]','task','open',NULL,NULL,NULL,1,1,NULL)`
    ).run();
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    const rowMatch = html.match(/<tr data-slug="product">[\s\S]*?<\/tr>/);
    expect(rowMatch).toBeTruthy();
    expect(rowMatch![0]).toMatch(/<td>1<\/td>/); // só a NOTA conta, a task não soma
  });

  it('restaurar padrão (reset) some com a área pré-criada e a customização', async () => {
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { 'vida-pessoal': { label: 'Vida Pessoal', color: '#22c55e' } }, kinds: {} }),
    });
    await SELF.fetch('https://x.test/app/config/taxonomy/reset', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
    });
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).not.toContain('vida-pessoal');
  });
});

describe('/app/notes — badges refletem cor/label customizados (spec 54)', () => {
  it('badge de área usa --chip com a cor resolvida e o LABEL customizado (não o slug cru)', async () => {
    await E.DB.prepare(`DELETE FROM notes WHERE id LIKE 'taxweb-list-%'`).run();
    await seedNote('taxweb-list-1', ['operations']);
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { operations: { label: 'Operações', color: '#ff00ff' } }, kinds: {} }),
    });
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('--chip:#ff00ff');
    expect(html).toContain('Operações');
  });

  it('kind badge usa label/cor customizados na lista de notas', async () => {
    await E.DB.prepare(`DELETE FROM notes WHERE id LIKE 'taxweb-kind-%'`).run();
    await seedNote('taxweb-kind-1', ['product']);
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: {}, kinds: { concept: { label: 'Conceito', color: '#7dd3fc' } } }),
    });
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('Conceito');
    expect(html).toContain('--chip:#7dd3fc');
  });
});

describe('/app/notes/:id — checkboxes de área incluem pré-criadas e preservam legado fora do canon', () => {
  it('área pré-criada na taxonomia aparece como checkbox mesmo com 0 notas', async () => {
    await seedNote('taxweb-detail-1', ['management']);
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { 'vida-pessoal': { label: 'Vida Pessoal', color: '#22c55e' } }, kinds: {} }),
    });
    const res = await SELF.fetch('https://x.test/app/notes/taxweb-detail-1', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-domain="vida-pessoal"');
    expect(html).toContain('Vida Pessoal');
  });

  it('domínio LEGADO fora do canon (salvo antes, ex. via MCP allow_new_domain) some da lista SEM isso: continua aparecendo como checkbox marcado', async () => {
    await seedNote('taxweb-detail-2', ['legado-fora-canon']);
    const res = await SELF.fetch('https://x.test/app/notes/taxweb-detail-2', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    // Sem essa proteção, o checkbox nunca existiria e o próximo autosave de
    // domains perderia o dado silenciosamente (data loss).
    expect(html).toContain('data-domain="legado-fora-canon"');
    expect(html).toMatch(/data-domain="legado-fora-canon"\s+checked/);
  });

  it('label customizado aparece com o slug em <code> ao lado (mono), label default não mostra slug duplicado', async () => {
    await seedNote('taxweb-detail-3', ['management']);
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { management: { label: 'Gestão', color: '#123456' } }, kinds: {} }),
    });
    const res = await SELF.fetch('https://x.test/app/notes/taxweb-detail-3', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('Gestão');
    expect(html).toContain('<code class="note-edit-domain-slug">management</code>');
  });
});

describe('POST /app/notes/update — domains aceita área pré-criada via taxonomia (extraAllowed)', () => {
  function post(body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    return SELF.fetch('https://x.test/app/notes/update', { method: 'POST', headers, body: JSON.stringify(body) });
  }

  beforeEach(async () => {
    E.AI = { run: async () => ({ data: [Array(1024).fill(0.3)] }) };
    E.VECTORIZE = { upsert: async () => ({}), query: async () => ({ matches: [] }) };
  });

  it('aceita um domínio pré-criado na taxonomia (não-canônico) via editor web', async () => {
    await seedNote('taxweb-update-1', ['management'], 1000);
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { 'vida-pessoal': { label: 'Vida Pessoal', color: '#22c55e' } }, kinds: {} }),
    });
    const res = await post({ id: 'taxweb-update-1', patch: { domains: ['vida-pessoal'] } }, await authCookie());
    expect(res.status).toBe(200);
    const n = await getNoteById(E, 'taxweb-update-1');
    expect(JSON.parse(n!.domains)).toEqual(['vida-pessoal']);
  });

  it('continua rejeitando slug fora do canon E fora da taxonomia (não vira porta aberta)', async () => {
    await seedNote('taxweb-update-2', ['management'], 1000);
    const res = await post({ id: 'taxweb-update-2', patch: { domains: ['nunca-registrado'] } }, await authCookie());
    expect(res.status).toBe(400);
  });
});
