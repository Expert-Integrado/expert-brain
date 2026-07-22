import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../../src/contacts/db/migrate';
import { runGoogleSync, GSYNC_KV } from '../../src/contacts/google/sync';
import { GOOGLE_SCOPE, GOOGLE_SCOPE_WRITE, scopeCanWrite } from '../../src/contacts/google/oauth';
import {
  buildContactUpdate, maybeEnqueueGooglePush, tryGooglePushNow, pushEntityToGoogle,
  drainGooglePushQueue, hasPendingPush, GPUSH_KV,
} from '../../src/contacts/google/push';
import { updateEntityFields } from '../../src/contacts/entity-write';
import {
  handleGoogleConnectStart, handleGoogleCallback, handleGoogleStatus,
  handleGoogleWriteBackPost, handleGoogleDisconnect,
} from '../../src/contacts/google/routes';
import { proxyTokenAllowsPath, writeTokenAllowsPath } from '../../src/contacts/auth/tokens';

// Write-back vault→Google (specs/google-contacts-sync.md, seção write-back).
// Mesmo idioma de mock do google-sync.test.ts (fetch global capturado, restaurado
// no afterEach; KV/D1 limpos no beforeEach), estendido com o MÉTODO HTTP — o push
// distingue GET do contato (leitura fresca) de PATCH :updateContact (escrita).
// Dados 100% fictícios (repo público): Ana Almeida e variações.

const E = env as any;

const ORIG_FETCH = globalThis.fetch;
let fetchCalls: Array<{ url: string; method: string; body: string }> = [];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GROUP = 'contactGroups/abc123';
const ENTITY = 'gtest-push-1';
const RESOURCE = 'people/p1';

function mockGoogle(responder: (url: string, body: string, method: string) => { status: number; body?: any }) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    fetchCalls.push({ url, method, body });
    const r = responder(url, body, method);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

// Contato como o Google devolve no getContact: listas COMPLETAS com metadata,
// canonicalForm e formattedType (campos output-only que o PATCH não pode ecoar).
function rawAna(over: Partial<any> = {}) {
  return {
    resourceName: RESOURCE,
    etag: 'et-1',
    names: [{ displayName: 'Ana Almeida', givenName: 'Ana', familyName: 'Almeida', metadata: { primary: true } }],
    phoneNumbers: [
      { value: '+55 11 98765-4321', canonicalForm: '+5511987654321', type: 'mobile', formattedType: 'Mobile', metadata: { primary: true } },
      { value: '+55 11 3333-4444', canonicalForm: '+551133334444', type: 'work' },
      { value: '+55 11 2222-1111', canonicalForm: '+551122221111', type: 'home' },
    ],
    emailAddresses: [
      { value: 'ana@exemplo.com.br', metadata: { primary: true } },
      { value: 'ana.pessoal@exemplo.com.br' },
    ],
    organizations: [{ name: 'Empresa X', title: 'Diretora', metadata: { primary: true } }],
    birthdays: [{ date: { year: 1980, month: 3, day: 7 } }],
    memberships: [{ contactGroupMembership: { contactGroupResourceName: GROUP } }],
    ...over,
  };
}

// Identidade do vault ESPELHANDO o extractPerson(rawAna()) — cada teste muda só
// o campo em foco, pra o diff conter exatamente o que o teste afirma.
const VAULT_BASE = {
  name: 'Ana Almeida', phone: '5511987654321', email: 'ana@exemplo.com.br',
  birthday: '1980-03-07', company: 'Empresa X', role: 'Diretora',
} as const;

const envG = () => ({ ...E, GOOGLE_CLIENT_ID: 'client-fake', GOOGLE_CLIENT_SECRET: 'secret-fake' });

async function connect(scope: string = GOOGLE_SCOPE_WRITE) {
  await E.CACHE.put(GSYNC_KV.oauth, JSON.stringify({ refresh_token: 'rt-fake', connected_at: '2026-07-18T00:00:00Z', scope }));
  await E.CACHE.put(GSYNC_KV.config, JSON.stringify({ groups: [GROUP] }));
}

async function writeBackOn(enabled = true) {
  await E.CACHE.put(GSYNC_KV.writeBack, JSON.stringify({ enabled }));
}

async function seedLinked(vault: Partial<Record<string, string | null>> = {}) {
  const v = { ...VAULT_BASE, ...vault };
  await E.DB.prepare(
    `INSERT INTO entities (id, kind, name, phone, email, birthday, company, role, source)
     VALUES (?, 'person', ?, ?, ?, ?, ?, ?, 'google')`
  ).bind(ENTITY, v.name, v.phone, v.email, v.birthday, v.company, v.role).run();
  await E.DB.prepare(
    `INSERT INTO google_links (resource_name, entity_id, etag) VALUES (?, ?, 'et-0')`
  ).bind(RESOURCE, ENTITY).run();
}

async function enqueue(id = ENTITY) {
  await E.DB.prepare(`INSERT INTO google_push_queue (entity_id) VALUES (?)`).bind(id).run();
}

async function queueRow(id = ENTITY) {
  return E.DB.prepare(`SELECT * FROM google_push_queue WHERE entity_id = ?`).bind(id).first();
}

// Responder padrão do push: refresh OK + getContact devolvendo `raw` + PATCH OK
// ecoando o contato com etag NOVO (como o Google real faz).
function respondPush(raw: any = rawAna(), patch?: (body: string) => { status: number; body?: any }) {
  mockGoogle((url, body, method) => {
    if (url.startsWith(TOKEN_URL)) return { status: 200, body: { access_token: 'at-fake' } };
    if (url.includes(':updateContact')) {
      return patch ? patch(body) : { status: 200, body: { ...raw, etag: 'et-2' } };
    }
    if (method === 'GET' && url.includes(`/v1/${RESOURCE}`)) return { status: 200, body: raw };
    return { status: 404 };
  });
}

function patchCalls() {
  return fetchCalls.filter((c) => c.url.includes(':updateContact'));
}

function updateFieldsParam(call: { url: string }): string[] {
  return (new URL(call.url).searchParams.get('updatePersonFields') ?? '').split(',').filter(Boolean);
}

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  fetchCalls = [];
  for (const k of [
    GSYNC_KV.client, GSYNC_KV.oauth, GSYNC_KV.config, GSYNC_KV.syncToken, GSYNC_KV.cursor,
    GSYNC_KV.lastRun, GSYNC_KV.failures, GSYNC_KV.alert, GSYNC_KV.writeBack,
    GPUSH_KV.lastPush, GPUSH_KV.failures,
  ]) {
    await E.CACHE.delete(k);
  }
  await E.DB.prepare(`DELETE FROM google_push_queue`).run();
  await E.DB.prepare(`DELETE FROM google_links`).run();
  await E.DB.prepare(`DELETE FROM entities WHERE source = 'google' OR id LIKE 'gtest-%'`).run();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

// ---------- buildContactUpdate: o diff cirúrgico (função pura) ----------

describe('buildContactUpdate — merge cirúrgico', () => {
  it('telefone novo muta SÓ o item primário; os outros 2 ficam; sem campos output-only', () => {
    const { person, fields } = buildContactUpdate(rawAna() as any, { ...VAULT_BASE, phone: '5511999998888' });
    expect(fields).toEqual(['phoneNumbers']);
    expect(person.etag).toBe('et-1');
    expect(person.phoneNumbers).toEqual([
      { value: '+5511999998888', type: 'mobile' },
      { value: '+55 11 3333-4444', type: 'work' },
      { value: '+55 11 2222-1111', type: 'home' },
    ]);
    // output-only NUNCA no corpo do PATCH (o Google rejeita/recalcula)
    const s = JSON.stringify(person);
    expect(s).not.toContain('canonicalForm');
    expect(s).not.toContain('formattedType');
    expect(s).not.toContain('metadata');
  });

  it('nome escreve via unstructuredName (displayName é read-only); e-mail preserva o secundário', () => {
    const { person, fields } = buildContactUpdate(rawAna() as any, { ...VAULT_BASE, name: 'Ana Nova', email: 'nova@exemplo.com.br' });
    expect(fields.sort()).toEqual(['emailAddresses', 'names']);
    expect(person.names).toEqual([{ unstructuredName: 'Ana Nova' }]);
    expect(JSON.stringify(person.names)).not.toContain('displayName');
    expect(person.emailAddresses).toEqual([
      { value: 'nova@exemplo.com.br' },
      { value: 'ana.pessoal@exemplo.com.br' },
    ]);
  });

  it('company/role dividem organizations: role novo preserva a company do Google no mesmo item', () => {
    const { person, fields } = buildContactUpdate(rawAna() as any, { ...VAULT_BASE, role: 'CEO', company: null });
    expect(fields).toEqual(['organizations']);
    expect(person.organizations).toEqual([{ name: 'Empresa X', title: 'CEO' }]);
  });

  it('vault null NUNCA limpa campo do Google; tudo igual → diff vazio', () => {
    const empty = buildContactUpdate(rawAna() as any, { name: null, phone: null, email: null, birthday: null, company: null, role: null });
    expect(empty.fields).toEqual([]);
    const same = buildContactUpdate(rawAna() as any, { ...VAULT_BASE });
    expect(same.fields).toEqual([]);
  });

  it('Google sem telefone + vault com telefone → item novo é ADICIONADO (não substitui nada)', () => {
    const { person, fields } = buildContactUpdate(rawAna({ phoneNumbers: undefined }) as any, { ...VAULT_BASE, phone: '5511999998888' });
    expect(fields).toEqual(['phoneNumbers']);
    expect(person.phoneNumbers).toEqual([{ value: '+5511999998888' }]);
  });

  it('aniversário: vault 0000 preserva o ANO do Google; mês-dia igual = sem diff', () => {
    // mesmo mês-dia, vault sem ano → nada a enviar
    const same = buildContactUpdate(rawAna() as any, { ...VAULT_BASE, birthday: '0000-03-07' });
    expect(same.fields).toEqual([]);
    // mês-dia diferente, vault sem ano → envia com o ano que o Google JÁ tinha
    const moved = buildContactUpdate(rawAna() as any, { ...VAULT_BASE, birthday: '0000-05-10' });
    expect(moved.fields).toEqual(['birthdays']);
    expect(moved.person.birthdays).toEqual([{ date: { year: 1980, month: 5, day: 10 } }]);
    // vault com ano conhecido diferente → ano do vault vence
    const year = buildContactUpdate(rawAna() as any, { ...VAULT_BASE, birthday: '1979-03-07' });
    expect(year.person.birthdays).toEqual([{ date: { year: 1979, month: 3, day: 7 } }]);
  });
});

// ---------- gates do enqueue ----------

describe('maybeEnqueueGooglePush — gates', () => {
  it('só enfileira com TUDO ligado: identidade no patch + toggle + escopo de escrita + vínculo', async () => {
    await seedLinked();
    // patch sem campo de identidade → nunca (dossiê não sai do vault)
    await connect(); await writeBackOn();
    expect(await maybeEnqueueGooglePush(E, ENTITY, { notes_text: 'dossiê' })).toBe(false);
    // toggle OFF → não
    await writeBackOn(false);
    expect(await maybeEnqueueGooglePush(E, ENTITY, { name: 'X' })).toBe(false);
    // escopo readonly (instalação antiga sem reautorizar) → não
    await writeBackOn(true);
    await connect(GOOGLE_SCOPE);
    expect(await maybeEnqueueGooglePush(E, ENTITY, { name: 'X' })).toBe(false);
    // sem vínculo → não (criação vault→Google é v2)
    await connect(GOOGLE_SCOPE_WRITE);
    expect(await maybeEnqueueGooglePush(E, 'gtest-sem-vinculo', { name: 'X' })).toBe(false);
    expect(await queueRow()).toBeNull();
    // tudo ligado → enfileira
    expect(await maybeEnqueueGooglePush(E, ENTITY, { name: 'X' })).toBe(true);
    expect(await hasPendingPush(E, ENTITY)).toBe(true);
  });

  it('re-edição de entidade já na fila reseta attempts/last_error (dedupe por PK)', async () => {
    await seedLinked(); await connect(); await writeBackOn();
    await enqueue();
    await E.DB.prepare(`UPDATE google_push_queue SET attempts = 3, last_error = 'boom' WHERE entity_id = ?`).bind(ENTITY).run();
    expect(await maybeEnqueueGooglePush(E, ENTITY, { phone: '5511999998888' })).toBe(true);
    const row = await queueRow();
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it('updateEntityFields enfileira por padrão; opts.enqueueGooglePush=false (pull) NÃO', async () => {
    await seedLinked(); await connect(); await writeBackOn();
    await updateEntityFields(E, ENTITY, { name: 'Ana Editada' }, undefined, { enqueueGooglePush: false });
    expect(await queueRow()).toBeNull();
    await updateEntityFields(E, ENTITY, { name: 'Ana Editada 2' });
    expect(await queueRow()).not.toBeNull();
  });
});

// ---------- pushEntityToGoogle: execução ----------

describe('pushEntityToGoogle', () => {
  it('sucesso: PATCH só do divergente, etag da RESPOSTA regravado, dequeue, last_push em KV', async () => {
    await seedLinked({ phone: '5511999998888' }); await connect(); await writeBackOn();
    await enqueue();
    respondPush();
    const r = await pushEntityToGoogle(envG(), ENTITY);
    expect(r).toEqual({ ok: true, pushed: ['phoneNumbers'] });
    const patches = patchCalls();
    expect(patches.length).toBe(1);
    expect(updateFieldsParam(patches[0])).toEqual(['phoneNumbers']);
    const sent = JSON.parse(patches[0].body);
    expect(sent.etag).toBe('et-1');
    expect(sent.names).toBeUndefined();
    const link = await E.DB.prepare(`SELECT etag FROM google_links WHERE resource_name = ?`).bind(RESOURCE).first();
    expect(link.etag).toBe('et-2');
    expect(await queueRow()).toBeNull();
    const last = JSON.parse((await E.CACHE.get(GPUSH_KV.lastPush))!);
    expect(last).toMatchObject({ entity_id: ENTITY, resource_name: RESOURCE, fields: ['phoneNumbers'] });
  });

  it('diff vazio (eco pós-pull) → noop, ZERO PATCH, etag fresco aproveitado, dequeue', async () => {
    await seedLinked(); await connect(); await writeBackOn();
    await enqueue();
    respondPush();
    const r = await pushEntityToGoogle(envG(), ENTITY);
    expect(r).toEqual({ ok: true, noop: 'no_diff' });
    expect(patchCalls().length).toBe(0);
    const link = await E.DB.prepare(`SELECT etag FROM google_links WHERE resource_name = ?`).bind(RESOURCE).first();
    expect(link.etag).toBe('et-1');
    expect(await queueRow()).toBeNull();
  });

  it('etag stale (FAILED_PRECONDITION) → 1 refetch+retry e sucesso', async () => {
    await seedLinked({ name: 'Ana Nova' }); await connect(); await writeBackOn();
    await enqueue();
    let patchN = 0;
    mockGoogle((url, _body, method) => {
      if (url.startsWith(TOKEN_URL)) return { status: 200, body: { access_token: 'at' } };
      if (url.includes(':updateContact')) {
        patchN++;
        if (patchN === 1) return { status: 400, body: { error: { status: 'FAILED_PRECONDITION' } } };
        return { status: 200, body: { ...rawAna(), etag: 'et-3' } };
      }
      if (method === 'GET') return { status: 200, body: rawAna({ etag: patchN === 0 ? 'et-1' : 'et-1b' }) };
      return { status: 404 };
    });
    const r = await pushEntityToGoogle(envG(), ENTITY);
    expect(r).toEqual({ ok: true, pushed: ['names'] });
    expect(patchN).toBe(2);
    // o retry recarregou o contato: o 2º PATCH saiu com o etag FRESCO
    expect(JSON.parse(patchCalls()[1].body).etag).toBe('et-1b');
    const link = await E.DB.prepare(`SELECT etag FROM google_links WHERE resource_name = ?`).bind(RESOURCE).first();
    expect(link.etag).toBe('et-3');
  });

  it('stale 2x → desiste com etag_stale_twice; fica na fila com attempts=1 pro cron', async () => {
    await seedLinked({ name: 'Ana Nova' }); await connect(); await writeBackOn();
    await enqueue();
    respondPush(rawAna(), () => ({ status: 400, body: { error: { status: 'FAILED_PRECONDITION' } } }));
    const r = await pushEntityToGoogle(envG(), ENTITY);
    expect(r).toEqual({ ok: false, error: 'etag_stale_twice' });
    const row = await queueRow();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('etag_stale_twice');
  });

  it('estado mudou pós-enqueue (toggle OFF / escopo readonly) → noop + dequeue, zero rede People', async () => {
    await seedLinked({ name: 'Ana Nova' }); await connect(); await writeBackOn(false);
    await enqueue();
    respondPush();
    expect(await pushEntityToGoogle(envG(), ENTITY)).toEqual({ ok: true, noop: 'write_back_off' });
    expect(await queueRow()).toBeNull();
    expect(fetchCalls.length).toBe(0);

    await writeBackOn(true); await connect(GOOGLE_SCOPE);
    await enqueue();
    expect(await pushEntityToGoogle(envG(), ENTITY)).toEqual({ ok: true, noop: 'no_write_scope' });
    expect(await queueRow()).toBeNull();
  });

  it('falha transiente (PATCH 500) fica na fila com last_error; drain seguinte recupera', async () => {
    await seedLinked({ name: 'Ana Nova' }); await connect(); await writeBackOn();
    await enqueue();
    respondPush(rawAna(), () => ({ status: 500 }));
    const d1 = await drainGooglePushQueue(envG());
    expect(d1).toMatchObject({ ok: false, failed: 1, pushed: 0 });
    expect((await queueRow()).last_error).toBe('update_contact_500');
    expect(await E.CACHE.get(GPUSH_KV.failures)).toBe('1');

    respondPush();
    const d2 = await drainGooglePushQueue(envG());
    expect(d2).toMatchObject({ ok: true, pushed: 1, failed: 0 });
    expect(await queueRow()).toBeNull();
    expect(await E.CACHE.get(GPUSH_KV.failures)).toBe('0');
  });

  it('tryGooglePushNow: fila vazia = zero IO de rede; com fila, empurra na hora', async () => {
    await seedLinked({ name: 'Ana Nova' }); await connect(); await writeBackOn();
    respondPush();
    await tryGooglePushNow(envG(), ENTITY);
    expect(fetchCalls.length).toBe(0);
    await enqueue();
    await tryGooglePushNow(envG(), ENTITY);
    expect(patchCalls().length).toBe(1);
    expect(await queueRow()).toBeNull();
  });

  it('drain respeita o teto (GSYNC_PUSH_MAX) e deixa o resto pro próximo ciclo', async () => {
    await connect(); await writeBackOn();
    for (const n of [1, 2, 3]) {
      await E.DB.prepare(
        `INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', ?, 'google')`
      ).bind(`gtest-many-${n}`, `Pessoa ${n}`).run();
      await E.DB.prepare(`INSERT INTO google_links (resource_name, entity_id, etag) VALUES (?, ?, 'e')`)
        .bind(`people/m${n}`, `gtest-many-${n}`).run();
      await enqueue(`gtest-many-${n}`);
    }
    mockGoogle((url, _b, method) => {
      if (url.startsWith(TOKEN_URL)) return { status: 200, body: { access_token: 'at' } };
      if (method === 'GET') return { status: 200, body: rawAna({ resourceName: url.match(/people\/m\d/)?.[0] ?? RESOURCE }) };
      return { status: 200, body: { etag: 'x' } };
    });
    const d = await drainGooglePushQueue({ ...envG(), GSYNC_PUSH_MAX: '2' });
    expect(d.pushed + d.noop + d.failed).toBe(2);
    const left = await E.DB.prepare(`SELECT COUNT(*) AS n FROM google_push_queue`).first();
    expect(left.n).toBe(1);
  });
});

// ---------- anti-loop e anti-clobber (interação com o pull) ----------

describe('write-back × pull', () => {
  function respondPull(connections: any[]) {
    mockGoogle((url) => {
      if (url.startsWith(TOKEN_URL)) return { status: 200, body: { access_token: 'at' } };
      if (url.includes('/people/me/connections')) return { status: 200, body: { connections, nextSyncToken: 's1' } };
      return { status: 404 };
    });
  }

  it('anti-loop: update vindo do PULL nunca enfileira push de volta', async () => {
    await seedLinked({ name: 'Ana Antiga' }); await connect(); await writeBackOn();
    respondPull([rawAna()]);
    const r = await runGoogleSync(envG());
    expect(r.updated).toBe(1);
    const ent = await E.DB.prepare(`SELECT name FROM entities WHERE id = ?`).bind(ENTITY).first();
    expect(ent.name).toBe('Ana Almeida'); // Google venceu no pull...
    expect(await queueRow()).toBeNull();  // ...sem virar push de volta (loop)
  });

  it('anti-clobber: push pendente SUSPENDE o "Google vence"; drenado, o pull volta a valer', async () => {
    await seedLinked({ name: 'Nome Editado No Vault' }); await connect(); await writeBackOn();
    await enqueue();
    respondPull([rawAna()]);
    const r1 = await runGoogleSync(envG());
    expect(r1.updated).toBe(0);
    let ent = await E.DB.prepare(`SELECT name FROM entities WHERE id = ?`).bind(ENTITY).first();
    expect(ent.name).toBe('Nome Editado No Vault'); // edição local preservada

    // fila drenada → pull seguinte aplica o Google normalmente
    await E.DB.prepare(`DELETE FROM google_push_queue`).run();
    await E.CACHE.delete(GSYNC_KV.syncToken);
    respondPull([rawAna()]);
    const r2 = await runGoogleSync(envG());
    expect(r2.updated).toBe(1);
    ent = await E.DB.prepare(`SELECT name FROM entities WHERE id = ?`).bind(ENTITY).first();
    expect(ent.name).toBe('Ana Almeida');
  });
});

// ---------- rotas: escopo dinâmico, toggle, status, disconnect, allowlists ----------

describe('rotas do write-back', () => {
  it('connect-start: toggle ON pede escopo FULL; OFF segue readonly', async () => {
    await writeBackOn();
    const on = (await (await handleGoogleConnectStart(new Request('https://contacts.test/google/connect-start', { method: 'POST' }), envG())).json()) as any;
    expect(on.auth_url).toContain(encodeURIComponent(GOOGLE_SCOPE_WRITE));
    expect(on.auth_url).not.toContain('contacts.readonly');
    await writeBackOn(false);
    const off = (await (await handleGoogleConnectStart(new Request('https://contacts.test/google/connect-start', { method: 'POST' }), envG())).json()) as any;
    expect(off.auth_url).toContain('contacts.readonly');
  });

  it('callback grava o scope do TOKEN RESPONSE (fonte autoritativa) → can_write reflete', async () => {
    await E.CACHE.put(`${GSYNC_KV.statePrefix}n1`, '1', { expirationTtl: 600 });
    mockGoogle((url) => url.startsWith(TOKEN_URL)
      ? { status: 200, body: { access_token: 'at', refresh_token: 'rt', scope: GOOGLE_SCOPE_WRITE } }
      : { status: 404 });
    await handleGoogleCallback(new Request('https://contacts.test/google/callback?code=c&state=n1'), envG());
    const oauth = JSON.parse((await E.CACHE.get(GSYNC_KV.oauth))!);
    expect(oauth.scope).toBe(GOOGLE_SCOPE_WRITE);
    expect(scopeCanWrite(oauth.scope)).toBe(true);
  });

  it('POST /google/write-back valida boolean e persiste; status expõe o bloco write_back', async () => {
    const bad = await handleGoogleWriteBackPost(new Request('https://x/google/write-back', { method: 'POST', body: JSON.stringify({ enabled: 'sim' }) }), E);
    expect(bad.status).toBe(400);
    const ok = await handleGoogleWriteBackPost(new Request('https://x/google/write-back', { method: 'POST', body: JSON.stringify({ enabled: true }) }), E);
    expect(((await ok.json()) as any).enabled).toBe(true);

    await connect(GOOGLE_SCOPE); // conectado mas SEM escopo de escrita
    await seedLinked(); await enqueue();
    const st = (await (await handleGoogleStatus(new Request('https://contacts.public.test/google/status'), envG())).json()) as any;
    expect(st.write_back).toEqual({ enabled: true });
    expect(st.can_write).toBe(false); // painel usa isso pra pedir reautorização
    expect(st.push_pending).toBe(1);
    expect(st.push_failures).toBe(0);
    expect(st.last_push).toBeNull();
  });

  it('instalação antiga (oauth sem scope gravado) → can_write false, nada quebra', async () => {
    await E.CACHE.put(GSYNC_KV.oauth, JSON.stringify({ refresh_token: 'rt', connected_at: 'x' }));
    const st = (await (await handleGoogleStatus(new Request('https://contacts.public.test/google/status'), envG())).json()) as any;
    expect(st.connected).toBe(true);
    expect(st.can_write).toBe(false);
  });

  it('disconnect limpa a fila de push junto com os vínculos', async () => {
    await seedLinked(); await connect(); await writeBackOn();
    await enqueue();
    await handleGoogleDisconnect(envG());
    const n = await E.DB.prepare(`SELECT COUNT(*) AS n FROM google_push_queue`).first();
    expect(n.n).toBe(0);
  });

  it('allowlist: /google/write-back só no WRITE token (nunca no proxy read-only)', () => {
    expect(writeTokenAllowsPath('/google/write-back')).toBe(true);
    expect(proxyTokenAllowsPath('/google/write-back')).toBe(false);
  });
});
