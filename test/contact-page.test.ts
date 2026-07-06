import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { signSession } from '../src/web/session.js';
import { handleContactPage } from '../src/web/contact-page.js';
import { runMigrations } from '../src/db/migrate.js';

// GET /app/contacts (página do grafo) lê getGraphPrefs (tabela `meta`) — precisa
// do schema aplicado mesmo rodando este arquivo isolado (mesmo padrão de
// test/web/graph-prefs.test.ts).
beforeAll(async () => {
  await runMigrations(env as any);
});

// Spec 50-console-v2/56 §3 — GET /app/contacts/<id>: página própria do contato.
// O service binding CONTACTS não é declarado em vitest.config.ts (mesmo padrão do
// resto do repo — ver test/contacts-entity-event-proxy.test.ts): os testes de
// ROTEAMENTO via SELF.fetch cobrem sessão + degradação graciosa (sem CONTACTS,
// a página renderiza o esqueleto normalmente, nunca um 404 falso); os testes de
// COMPORTAMENTO com a entidade resolvida/ausente chamam handleContactPage
// diretamente com um CONTACTS fabricado (mesmo racional do mockEnv em
// similar-edges.test.ts do expert-contacts).

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function envWithContacts(respond: (url: URL) => { status: number; body: unknown }): any {
  return {
    ...env,
    CONTACTS: {
      fetch: async (req: Request) => {
        const r = respond(new URL(req.url));
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
    CONTACTS_PROXY_TOKEN: 'test-proxy-token',
  };
}

describe('GET /app/contacts/<id> — roteamento (spec 56, critério 1)', () => {
  it('sem sessão → 302 (redirect pro login)', async () => {
    const res = await SELF.fetch('https://x/app/contacts/abc123', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('com sessão mas CONTACTS não configurado → 200 (degrada, NÃO é 404 falso)', async () => {
    const ck = await cookie();
    const res = await SELF.fetch('https://x/app/contacts/abc123', { headers: { cookie: ck }, redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-contact-id="abc123"');
    expect(html).toContain('/app/contacts/contact-page.bundle.js');
  });

  it('não engole as rotas exatas /app/contacts, /app/contacts/data, /app/contacts/meta', async () => {
    const ck = await cookie();
    // /app/contacts (sem id) continua na página do GRAFO de contatos, não na
    // página de UM contato — resposta tem o canvas do grafo, não o esqueleto
    // .contact-page.
    const graphPage = await SELF.fetch('https://x/app/contacts', { headers: { cookie: ck }, redirect: 'manual' });
    expect(graphPage.status).toBe(200);
    const graphHtml = await graphPage.text();
    expect(graphHtml).not.toContain('contact-page');
    expect(graphHtml).toContain('graph-canvas');

    // /app/contacts/data e /app/contacts/meta seguem indo pro proxy (503 sem
    // CONTACTS configurado) — nunca pro handleContactPage (que devolveria 200
    // com esqueleto pra um "contato" chamado "data"/"meta").
    const dataRes = await SELF.fetch('https://x/app/contacts/data', { headers: { cookie: ck }, redirect: 'manual' });
    expect(dataRes.status).toBe(503);
    const metaRes = await SELF.fetch('https://x/app/contacts/meta', { headers: { cookie: ck }, redirect: 'manual' });
    expect(metaRes.status).toBe(503);
  });
});

describe('GET /app/contacts/entity/neighbors — proxy read-only (spec 56, critério 7)', () => {
  it('sem sessão → 302', async () => {
    const res = await SELF.fetch('https://x/app/contacts/entity/neighbors?id=abc', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('com sessão mas CONTACTS/CONTACTS_PROXY_TOKEN não configurados → 503 (degradação graciosa)', async () => {
    const ck = await cookie();
    const res = await SELF.fetch('https://x/app/contacts/entity/neighbors?id=abc', {
      headers: { cookie: ck },
      redirect: 'manual',
    });
    expect(res.status).toBe(503);
  });
});

describe('handleContactPage — comportamento com CONTACTS fabricado', () => {
  it('id em formato inválido → 404 amigável (sem round-trip pro contacts)', async () => {
    const res = await handleContactPage(
      new Request('https://x/app/contacts/tem espaço', { headers: { cookie: await cookie() } }),
      env as any,
      'tem espaço',
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('não encontrado');
  });

  it('entity_not_found do proxy → 404 amigável', async () => {
    const fakeEnv = envWithContacts(() => ({ status: 404, body: { ok: false, error: 'entity_not_found', id: 'ghost' } }));
    const res = await handleContactPage(
      new Request('https://x/app/contacts/ghost', { headers: { cookie: await cookie() } }),
      fakeEnv,
      'ghost',
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('não encontrado');
  });

  it('entidade encontrada → 200 com esqueleto (client hidrata os 3 dados)', async () => {
    const fakeEnv = envWithContacts(() => ({
      status: 200,
      body: { id: 'real-id', vault: 'contacts', title: 'Fulano', kind: 'person', fields: [], connections: [] },
    }));
    const res = await handleContactPage(
      new Request('https://x/app/contacts/real-id', { headers: { cookie: await cookie() } }),
      fakeEnv,
      'real-id',
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-contact-id="real-id"');
    expect(html).toContain('/app/contacts/contact-page.bundle.js');
  });

  it('sem sessão → redirect do gate de sessão, nunca chega a consultar o contacts', async () => {
    const res = await handleContactPage(new Request('https://x/app/contacts/abc'), env as any, 'abc');
    expect(res.status).toBe(302);
  });
});
