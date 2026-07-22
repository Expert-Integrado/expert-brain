import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { provisionContacts, hasContactsModule, ensureContactsBinding, contactsEnvFrom } from '../../src/contacts-gateway.js';
import { signSession } from '../../src/web/session.js';

// ─────────────────────────────────────────────────────────────────────────────
// Suíte do GATEWAY da fusão (F2): o worker do Brain com DB_CONTACTS/KV_CONTACTS
// bound. Prova as 4 propriedades do modo fundido:
//   1. provision duplo — /setup/provision (aqui via provisionContacts direto)
//      aplica o schema do contacts no D1 PRÓPRIO, sem tocar no do Brain;
//   2. mount público — /contacts/* (API de entidades, prefixo stripado) e os
//      namespaces de integração (/google|/whatsapp|/instagram|/pipedrive) nos
//      paths ORIGINAIS, com as allowlists de token intactas;
//   3. console standalone morto — /contacts/app/* = 404 público;
//   4. adapter in-process — o painel do Brain (/app/contacts/data, sessão)
//      atravessa env.CONTACTS injetado e volta com o grafo do contacts.
// ─────────────────────────────────────────────────────────────────────────────

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  // Espelho do handleProvision do worker único: migrations do Brain no DB,
  // migrations do contacts no DB_CONTACTS (via o MESMO provisionContacts de prod).
  await runMigrations(E);
  await provisionContacts(E);
});

describe('provision duplo (F2 §provision)', () => {
  it('hasContactsModule enxerga os bindings da suíte', () => {
    expect(hasContactsModule(E)).toBe(true);
  });

  it('schema do contacts vive no DB_CONTACTS, não no DB do Brain', async () => {
    const inContacts = await E.DB_CONTACTS.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
    ).first();
    expect(inContacts?.name).toBe('entities');
    const inBrain = await E.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
    ).first();
    expect(inBrain).toBeNull();
    // E o _migrations de cada um é o seu — nenhuma colisão de runner.
    const brainNotes = await E.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='notes'"
    ).first();
    expect(brainNotes?.name).toBe('notes');
  });

  it('provisionContacts é idempotente (re-rodar é no-op)', async () => {
    await provisionContacts(E);
    const t = await E.DB_CONTACTS.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
    ).first();
    expect(t?.name).toBe('entities');
  });
});

describe('mount público /contacts/* (F2 §rotas)', () => {
  it('GET /contacts/health responde o health do módulo (rota pública)', async () => {
    const res = await SELF.fetch('https://brain-test.example.com/contacts/health');
    expect(res.status).toBe(200);
    // O marcador de build só existe no router do contacts — prova que o dispatch
    // chegou no módulo, não num handler do Brain.
    expect(res.headers.get('x-build-marker')).toBeTruthy();
  });

  it('POST /contacts/save_person exige bearer (allowlist intacta)', async () => {
    const res = await SELF.fetch('https://brain-test.example.com/contacts/save_person', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sem Token' }),
    });
    expect(res.status).toBe(401);
  });

  it('save_person com OWNER_TOKEN grava e get_contact_by_phone acha', async () => {
    const save = await SELF.fetch('https://brain-test.example.com/contacts/save_person', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${E.CONTACTS_OWNER_TOKEN}`,
      },
      body: JSON.stringify({ name: 'Fulano Gateway', phone: '+5511900001234', role: 'Teste F2' }),
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as any;
    expect(saved.id ?? saved.entity?.id ?? saved.person?.id).toBeTruthy();

    const get = await SELF.fetch(
      'https://brain-test.example.com/contacts/get_contact_by_phone?phone=%2B5511900001234',
      { headers: { authorization: `Bearer ${E.CONTACTS_OWNER_TOKEN}` } }
    );
    expect(get.status).toBe(200);
    const body = await get.text();
    expect(body).toContain('Fulano Gateway');
  });

  it('/contacts/app/* é 404 (console standalone morto no worker único)', async () => {
    for (const path of ['/contacts/app', '/contacts/app/', '/contacts/app/graph/data', '/contacts/app/login']) {
      const res = await SELF.fetch(`https://brain-test.example.com${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('path fora do módulo segue pro 404 do Brain (gateway devolve null)', async () => {
    const res = await SELF.fetch('https://brain-test.example.com/contactsfake/health');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-build-marker')).toBeNull();
  });
});

describe('namespaces de integração nos paths originais (F2 §rotas)', () => {
  it('GET /google/status sem bearer → 401 do contacts (mount vivo, auth intacta)', async () => {
    const res = await SELF.fetch('https://brain-test.example.com/google/status');
    expect(res.status).toBe(401);
  });

  it('GET /google/status com proxy token → 200 (allowlist read-only preservada)', async () => {
    const res = await SELF.fetch('https://brain-test.example.com/google/status', {
      headers: { authorization: `Bearer ${E.CONTACTS_PROXY_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('GET /pipedrive/status e /whatsapp/status sem bearer → 401 (não 404 do Brain)', async () => {
    for (const path of ['/pipedrive/status', '/whatsapp/status']) {
      const res = await SELF.fetch(`https://brain-test.example.com${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it('rotas de push com bearer próprio: sem secret configurado → 503 (integração desligada)', async () => {
    // WHATSAPP_SYNC_TOKEN não está bound nesta suíte — o contrato é 503, nunca
    // 404 (que significaria mount quebrado) nem 200 (que significaria bypass).
    const res = await SELF.fetch('https://brain-test.example.com/whatsapp/groups/config');
    expect(res.status).toBe(503);
  });
});

describe('adapter in-process env.CONTACTS (F2 §adapter)', () => {
  it('painel do Brain /app/contacts/data com sessão atravessa o módulo e volta grafo', async () => {
    const res = await SELF.fetch('https://brain-test.example.com/app/contacts/data', {
      headers: { cookie: await cookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Grafo do contacts: contrato de shape (nodes/links) e o Fulano gravado no
    // teste anterior presente — round-trip completo Brain → módulo → Brain.
    expect(Array.isArray(body.nodes)).toBe(true);
    const names = body.nodes.map((n: any) => n.title ?? n.name ?? n.label ?? '');
    expect(names.join('|')).toContain('Fulano Gateway');
  });

  it('/app/contacts/data sem sessão → redirect/401 do Brain (sessão continua na frente)', async () => {
    const res = await SELF.fetch('https://brain-test.example.com/app/contacts/data', { redirect: 'manual' });
    expect([302, 401]).toContain(res.status);
  });

  it('ensureContactsBinding não sobrescreve um CONTACTS já presente (modo dual)', () => {
    const marker = { fetch: () => Promise.resolve(new Response('real-binding')) };
    const fakeEnv = { ...E, CONTACTS: marker };
    ensureContactsBinding(fakeEnv);
    expect(fakeEnv.CONTACTS).toBe(marker);
  });

  it('sem DB_CONTACTS/KV_CONTACTS o gateway não ativa (instalação sem contatos)', () => {
    const bare = { ...E, CONTACTS: undefined, DB_CONTACTS: undefined };
    ensureContactsBinding(bare);
    expect(bare.CONTACTS).toBeUndefined();
    expect(hasContactsModule(bare)).toBe(false);
  });
});

describe('mapper contactsEnvFrom (F2 §bindings)', () => {
  it('traduz os bindings e NÃO vaza os secrets de console/SSO do Brain', () => {
    const c = contactsEnvFrom(E) as any;
    expect(c.DB).toBe(E.DB_CONTACTS);
    expect(c.CACHE).toBe(E.KV_CONTACTS);
    expect(c.OWNER_TOKEN).toBe(E.CONTACTS_OWNER_TOKEN);
    expect(c.PUBLIC_BRAIN_URL).toBe(E.WORKER_URL);
    // Console standalone morreu: nada de credencial de login do Brain descendo.
    expect(c.OWNER_EMAIL).toBeUndefined();
    expect(c.OWNER_PASSWORD_HASH).toBeUndefined();
    expect(c.SESSION_SECRET).toBeUndefined();
    expect(c.SSO_SECRET).toBeUndefined();
  });
});
