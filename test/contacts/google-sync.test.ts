import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../../src/contacts/db/migrate';
import { runGoogleSync, upsertFromGoogle, extractPerson, GSYNC_KV } from '../../src/contacts/google/sync';
import {
  handleGoogleCallback, handleGoogleConnectStart, handleGoogleConfig, handleGoogleDisconnect,
  handleGoogleClientPost, handleGoogleStatus,
} from '../../src/contacts/google/routes';
import { proxyTokenAllowsPath, writeTokenAllowsPath } from '../../src/contacts/auth/tokens';

// Sync Google Contacts → Contacts, mão única (specs/google-contacts-sync.md).
// Mesmo idioma de mock do maintenance-sync.test.ts: fetch global substituído,
// chamadas capturadas, restaurado no afterEach; KV gsync:* limpo no beforeEach.
// Dados 100% fictícios (repo público): Ana Almeida, Bruno Castro, Carla Souza.

const E = env as any;

const ORIG_FETCH = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: string }> = [];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Responder por URL: token endpoint e People API na mesma malha.
function mockGoogle(responder: (url: string, body: string) => { status: number; body?: any }) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    fetchCalls.push({ url, body });
    const r = responder(url, body);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const GROUP = 'contactGroups/abc123';
const OTHER_GROUP = 'contactGroups/zzz999';

function gPerson(over: Partial<any> = {}) {
  return {
    resourceName: 'people/p1',
    etag: 'et1',
    names: [{ displayName: 'Ana Almeida' }],
    phoneNumbers: [{ canonicalForm: '+5511987654321' }],
    emailAddresses: [{ value: 'Ana@Exemplo.com.br' }],
    memberships: [{ contactGroupMembership: { contactGroupResourceName: GROUP } }],
    ...over,
  };
}

function connectionsBody(connections: any[], over: Partial<any> = {}) {
  return { connections, nextSyncToken: 'sync-tok-1', ...over };
}

// Env com client OAuth fake + refresh_token conectado + grupo configurado.
const envG = () => ({ ...E, GOOGLE_CLIENT_ID: 'client-fake', GOOGLE_CLIENT_SECRET: 'secret-fake' });

async function connect(groups: string[] = [GROUP]) {
  await E.CACHE.put(GSYNC_KV.oauth, JSON.stringify({ refresh_token: 'rt-fake', connected_at: '2026-07-08T00:00:00Z' }));
  await E.CACHE.put(GSYNC_KV.config, JSON.stringify({ groups }));
}

// responder padrão: refresh de token OK + 1 página de connections
function respondWith(connections: any[], pageOver: Partial<any> = {}) {
  mockGoogle((url) => {
    if (url.startsWith(TOKEN_URL)) return { status: 200, body: { access_token: 'at-fake' } };
    if (url.includes('/people/me/connections')) return { status: 200, body: connectionsBody(connections, pageOver) };
    return { status: 404 };
  });
}

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  fetchCalls = [];
  for (const k of [GSYNC_KV.client, GSYNC_KV.oauth, GSYNC_KV.config, GSYNC_KV.syncToken, GSYNC_KV.cursor, GSYNC_KV.lastRun, GSYNC_KV.failures, GSYNC_KV.alert, GSYNC_KV.writeBack]) {
    await E.CACHE.delete(k);
  }
  await E.DB.prepare(`DELETE FROM google_push_queue`).run();
  await E.DB.prepare(`DELETE FROM google_links`).run();
  await E.DB.prepare(`DELETE FROM entities WHERE source = 'google' OR id LIKE 'gtest-%'`).run();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('extractPerson', () => {
  it('extrai campos e normaliza telefone/email; aniversário sem ano vira 0000', () => {
    const x = extractPerson(gPerson({ birthdays: [{ date: { month: 3, day: 7 } }] }) as any);
    expect(x.name).toBe('Ana Almeida');
    expect(x.phone).toBe('5511987654321');
    expect(x.email).toBe('ana@exemplo.com.br');
    expect(x.birthday).toBe('0000-03-07');
    expect(x.groups).toEqual([GROUP]);
    expect(x.deleted).toBe(false);
  });
});

describe('runGoogleSync — gates', () => {
  it('não conectado → skipped, zero chamada de rede', async () => {
    const r = await runGoogleSync(envG());
    expect(r).toEqual({ ok: true, skipped: 'not_connected' });
    expect(fetchCalls.length).toBe(0);
  });

  it('conectado sem etiqueta configurada → skipped (nunca espelho total)', async () => {
    await E.CACHE.put(GSYNC_KV.oauth, JSON.stringify({ refresh_token: 'rt', connected_at: 'x' }));
    const r = await runGoogleSync(envG());
    expect(r).toEqual({ ok: true, skipped: 'no_groups_configured' });
  });

  it('refresh com invalid_grant → erro + alerta de reconexão + contador de falha', async () => {
    await connect();
    mockGoogle((url) => url.startsWith(TOKEN_URL)
      ? { status: 400, body: { error: 'invalid_grant' } }
      : { status: 500 });
    const r = await runGoogleSync(envG());
    expect(r.ok).toBe(false);
    const alert = JSON.parse((await E.CACHE.get(GSYNC_KV.alert))!);
    expect(alert.kind).toBe('gsync_reconnect_required');
    expect(await E.CACHE.get(GSYNC_KV.failures)).toBe('1');
  });
});

describe('runGoogleSync — pageSize segue o teto por invocação', () => {
  // Regressão do incidente 19/07: PAGE_SIZE fixo em 200 tornava GSYNC_MAX_PERSONS
  // < 200 inerte (a página inteira era processada antes do check do teto, e o cap
  // de ~1000 subrequests do runtime estourava ANTES do cursor salvar).
  it('GSYNC_MAX_PERSONS=40 → pede pageSize=40 ao Google', async () => {
    await connect();
    respondWith([gPerson()]);
    const r = await runGoogleSync({ ...envG(), GSYNC_MAX_PERSONS: '40' });
    expect(r.ok).toBe(true);
    const conn = fetchCalls.find((c) => c.url.includes('/people/me/connections'))!;
    expect(conn.url).toContain('pageSize=40');
  });

  it('teto acima do máximo da API → clampa em 200', async () => {
    await connect();
    respondWith([gPerson()]);
    await runGoogleSync({ ...envG(), GSYNC_MAX_PERSONS: '5000' });
    const conn = fetchCalls.find((c) => c.url.includes('/people/me/connections'))!;
    expect(conn.url).toContain('pageSize=200');
  });
});

describe('runGoogleSync — colisão de telefone (UNIQUE global vs dedupe só-person)', () => {
  it('número já pertence a entidade NÃO-person → cria sem telefone e o run não morre', async () => {
    await connect();
    await E.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, source, private)
       VALUES ('gtest-comp1', 'company', 'Empresa Fictícia SA', '5511944445555', 'manual', 0)`
    ).run();
    respondWith([gPerson({
      resourceName: 'people/pc1',
      names: [{ displayName: 'Diego Teste' }],
      phoneNumbers: [{ canonicalForm: '+5511944445555' }],
      emailAddresses: [{ value: 'diego@exemplo.com.br' }],
    })]);
    const r = await runGoogleSync(envG());
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
    const created = await E.DB.prepare(`SELECT phone, email FROM entities WHERE name = 'Diego Teste'`).first();
    expect(created.phone).toBeNull(); // telefone ficou com a empresa
    expect(created.email).toBe('diego@exemplo.com.br');
    const comp = await E.DB.prepare(`SELECT phone FROM entities WHERE id = 'gtest-comp1'`).first();
    expect(comp.phone).toBe('5511944445555');
  });

  it('update: telefone novo do Google que pertence a OUTRA entidade não entra no patch', async () => {
    await connect();
    await E.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, source, private)
       VALUES ('gtest-e1', 'person', 'Elisa Teste', '5511900001111', 'google', 0)`
    ).run();
    await E.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, source, private)
       VALUES ('gtest-e2', 'person', 'Fabio Teste', '5511900002222', 'manual', 0)`
    ).run();
    await E.DB.prepare(
      `INSERT INTO google_links (resource_name, entity_id, etag, synced_at)
       VALUES ('people/pe1', 'gtest-e1', 'et0', datetime('now'))`
    ).run();
    respondWith([gPerson({
      resourceName: 'people/pe1',
      names: [{ displayName: 'Elisa Teste' }],
      phoneNumbers: [{ canonicalForm: '+5511900002222' }],
      emailAddresses: [],
    })]);
    const r = await runGoogleSync(envG());
    expect(r.ok).toBe(true);
    const e1 = await E.DB.prepare(`SELECT phone FROM entities WHERE id = 'gtest-e1'`).first();
    expect(e1.phone).toBe('5511900001111'); // manteve o atual — conflito só logado
    const e2 = await E.DB.prepare(`SELECT phone FROM entities WHERE id = 'gtest-e2'`).first();
    expect(e2.phone).toBe('5511900002222');
  });
});

describe('runGoogleSync — upsert e política de campos', () => {
  it('pessoa nova na etiqueta → created com source=google + vínculo; fora da etiqueta → ignorada', async () => {
    await connect();
    respondWith([
      gPerson(),
      gPerson({
        resourceName: 'people/p2',
        names: [{ displayName: 'Bruno Castro' }],
        phoneNumbers: [{ canonicalForm: '+5511911112222' }],
        memberships: [{ contactGroupMembership: { contactGroupResourceName: OTHER_GROUP } }],
      }),
    ]);
    const r = await runGoogleSync(envG());
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
    expect(r.ignored_out_of_groups).toBe(1);

    const ana = await E.DB.prepare(`SELECT * FROM entities WHERE phone = '5511987654321'`).first();
    expect(ana.name).toBe('Ana Almeida');
    expect(ana.source).toBe('google');
    expect(ana.private).toBe(0);
    const link = await E.DB.prepare(`SELECT * FROM google_links WHERE resource_name = 'people/p1'`).first();
    expect(link.entity_id).toBe(ana.id);
    expect(link.etag).toBe('et1');
    // syncToken da última página persistido pro próximo run ser incremental
    expect(await E.CACHE.get(GSYNC_KV.syncToken)).toBe('sync-tok-1');
  });

  it('match por telefone (variante do 9º dígito) → Google vence em name/email; company/role só preenchem vazio', async () => {
    await connect();
    // Entidade local SEM o 9º dígito, com company própria e notes de dossiê.
    await E.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, company, notes_text, source)
       VALUES ('gtest-1', 'person', 'Ana A.', '551187654321', 'Empresa Exemplo Ltda', 'dossiê local', 'manual')`
    ).run();
    respondWith([gPerson({ organizations: [{ name: 'Outra Empresa', title: 'Diretora' }] })]);
    const r = await runGoogleSync(envG());
    expect(r.updated).toBe(1);
    expect(r.created).toBe(0);

    const row = await E.DB.prepare(`SELECT * FROM entities WHERE id = 'gtest-1'`).first();
    expect(row.name).toBe('Ana Almeida');                 // Google vence
    expect(row.email).toBe('ana@exemplo.com.br');         // Google vence
    expect(row.phone).toBe('5511987654321');              // Google vence (formato canônico)
    expect(row.company).toBe('Empresa Exemplo Ltda');     // fill-empty: NÃO sobrescreve
    expect(row.role).toBe('Diretora');                    // fill-empty: estava vazio, preenche
    expect(row.notes_text).toBe('dossiê local');          // dossiê intocado
    const link = await E.DB.prepare(`SELECT entity_id FROM google_links WHERE resource_name = 'people/p1'`).first();
    expect(link.entity_id).toBe('gtest-1');
  });

  it('nada mudou → unchanged, sem write de entidade', async () => {
    await connect();
    respondWith([gPerson({ organizations: undefined, emailAddresses: [{ value: 'ana@exemplo.com.br' }] })]);
    await runGoogleSync(envG());
    respondWith([gPerson({ organizations: undefined, emailAddresses: [{ value: 'ana@exemplo.com.br' }] })]);
    const r2 = await runGoogleSync(envG());
    expect(r2.unchanged).toBe(1);
    expect(r2.updated).toBe(0);
  });

  it('deletado no Google → só desfaz o vínculo; entidade e dossiê ficam', async () => {
    await connect();
    respondWith([gPerson()]);
    await runGoogleSync(envG());
    const before = await E.DB.prepare(`SELECT COUNT(*) AS n FROM google_links`).first();
    expect(before.n).toBe(1);

    respondWith([gPerson({ metadata: { deleted: true }, names: undefined })]);
    const r = await runGoogleSync(envG());
    expect(r.unlinked).toBe(1);
    const after = await E.DB.prepare(`SELECT COUNT(*) AS n FROM google_links`).first();
    expect(after.n).toBe(0);
    const ent = await E.DB.prepare(`SELECT name FROM entities WHERE phone = '5511987654321'`).first();
    expect(ent.name).toBe('Ana Almeida');
  });
});

describe('runGoogleSync — teto, cursor e syncToken expirado', () => {
  it('teto atingido com mais páginas → partial + cursor resumível; run seguinte continua', async () => {
    await connect();
    mockGoogle((url) => {
      if (url.startsWith(TOKEN_URL)) return { status: 200, body: { access_token: 'at' } };
      if (url.includes('pageToken=page2')) {
        return { status: 200, body: connectionsBody([gPerson({ resourceName: 'people/p9', names: [{ displayName: 'Carla Souza' }], phoneNumbers: [{ canonicalForm: '+5511933334444' }] })]) };
      }
      return { status: 200, body: { connections: [gPerson()], nextPageToken: 'page2' } };
    });
    const r1 = await runGoogleSync(envG(), { max: 1 });
    expect(r1.partial).toBe(true);
    expect(JSON.parse((await E.CACHE.get(GSYNC_KV.cursor))!).pageToken).toBe('page2');

    const r2 = await runGoogleSync(envG(), { max: 10 });
    expect(r2.partial).toBeUndefined();
    expect(await E.CACHE.get(GSYNC_KV.cursor)).toBeNull();
    const n = await E.DB.prepare(`SELECT COUNT(*) AS n FROM google_links`).first();
    expect(n.n).toBe(2);
  });

  it('410 EXPIRED no incremental → recomeça FULL na mesma invocação', async () => {
    await connect();
    await E.CACHE.put(GSYNC_KV.syncToken, 'sync-velho');
    mockGoogle((url) => {
      if (url.startsWith(TOKEN_URL)) return { status: 200, body: { access_token: 'at' } };
      if (url.includes('syncToken=sync-velho')) return { status: 410 };
      return { status: 200, body: connectionsBody([gPerson()], { nextSyncToken: 'sync-novo' }) };
    });
    const r = await runGoogleSync(envG());
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('full');
    expect(r.created).toBe(1);
    expect(await E.CACHE.get(GSYNC_KV.syncToken)).toBe('sync-novo');
  });
});

describe('rotas OAuth', () => {
  it('connect-start gera nonce em KV e auth_url com escopo readonly', async () => {
    const res = await handleGoogleConnectStart(new Request('https://contacts.test/google/connect-start', { method: 'POST' }), envG());
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.auth_url).toContain('contacts.readonly');
    expect(body.auth_url).toContain('prompt=consent');
    expect(body.auth_url).toContain(encodeURIComponent('https://contacts.test/google/callback'));
    const state = new URL(body.auth_url).searchParams.get('state')!;
    expect(await E.CACHE.get(`${GSYNC_KV.statePrefix}${state}`)).toBe('1');
  });

  it('callback com state desconhecido → redirect com erro, sem troca de code', async () => {
    const res = await handleGoogleCallback(new Request('https://contacts.test/google/callback?code=c&state=forjado'), envG());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('google=error%3Abad_state');
    expect(fetchCalls.length).toBe(0);
  });

  it('callback com state válido → troca code, grava refresh_token e redireciona conectado; nonce é uso único', async () => {
    await E.CACHE.put(`${GSYNC_KV.statePrefix}nonce1`, '1', { expirationTtl: 600 });
    mockGoogle((url) => url.startsWith(TOKEN_URL)
      ? { status: 200, body: { access_token: 'at', refresh_token: 'rt-novo' } }
      : { status: 404 });
    const res = await handleGoogleCallback(new Request('https://contacts.test/google/callback?code=c1&state=nonce1'), envG());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('google=connected');
    const oauth = JSON.parse((await E.CACHE.get(GSYNC_KV.oauth))!);
    expect(oauth.refresh_token).toBe('rt-novo');
    expect(await E.CACHE.get(`${GSYNC_KV.statePrefix}nonce1`)).toBeNull();
    // replay do mesmo state → rejeitado
    const replay = await handleGoogleCallback(new Request('https://contacts.test/google/callback?code=c2&state=nonce1'), envG());
    expect(replay.headers.get('location')).toContain('google=error%3Abad_state');
  });

  it('config valida shape e reseta o syncToken (mudou o recorte → próximo run é FULL)', async () => {
    await E.CACHE.put(GSYNC_KV.syncToken, 'tok');
    const bad = await handleGoogleConfig(new Request('https://x/google/config', { method: 'POST', body: JSON.stringify({ groups: ['lixo'] }) }), envG());
    expect(bad.status).toBe(400);
    const ok = await handleGoogleConfig(new Request('https://x/google/config', { method: 'POST', body: JSON.stringify({ groups: [GROUP] }) }), envG());
    expect(ok.status).toBe(200);
    expect(await E.CACHE.get(GSYNC_KV.syncToken)).toBeNull();
    expect(JSON.parse((await E.CACHE.get(GSYNC_KV.config))!).groups).toEqual([GROUP]);
  });

  it('disconnect apaga credencial/estado e vínculos, preservando entidades', async () => {
    await connect();
    respondWith([gPerson()]);
    await runGoogleSync(envG());
    const res = await handleGoogleDisconnect(envG());
    const body = await res.json() as any;
    expect(body.links_removed).toBe(1);
    expect(await E.CACHE.get(GSYNC_KV.oauth)).toBeNull();
    const ent = await E.DB.prepare(`SELECT COUNT(*) AS n FROM entities WHERE source = 'google'`).first();
    expect(ent.n).toBe(1);
  });
});

describe('allowlists de token (src/auth/tokens.ts)', () => {
  it('proxy token lê status/labels; write token só as mutações do gsync', () => {
    expect(proxyTokenAllowsPath('/google/status')).toBe(true);
    expect(proxyTokenAllowsPath('/google/labels')).toBe(true);
    expect(proxyTokenAllowsPath('/google/sync')).toBe(false);
    expect(proxyTokenAllowsPath('/google/client')).toBe(false);
    expect(writeTokenAllowsPath('/google/connect-start')).toBe(true);
    expect(writeTokenAllowsPath('/google/config')).toBe(true);
    expect(writeTokenAllowsPath('/google/client')).toBe(true);
    expect(writeTokenAllowsPath('/google/sync')).toBe(true);
    expect(writeTokenAllowsPath('/google/disconnect')).toBe(true);
    expect(writeTokenAllowsPath('/save_person')).toBe(false);
    expect(writeTokenAllowsPath('/app/entity/event')).toBe(false);
  });
});

// Credencial do OAuth client colada no painel (modo painel): KV gsync:client com
// precedência sobre env, id mascarado nas respostas, secret jamais ecoado.
describe('POST /google/client — credencial pelo painel', () => {
  const PANEL_ID = 'panel-abc-123.apps.googleusercontent.com';
  const postClient = (body: unknown, e: any = E) =>
    handleGoogleClientPost(new Request('https://contacts.test/google/client', { method: 'POST', body: JSON.stringify(body) }), e);

  it('salva no KV; resposta traz id mascarado e NUNCA o secret', async () => {
    const res = await postClient({ client_id: PANEL_ID, client_secret: 'GOCSPX-fake-1' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('GOCSPX-fake-1');
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, mode: 'panel', disconnected: false });
    expect(body.client_id).toBe(`${PANEL_ID.slice(0, 12)}…`);
    expect(JSON.parse((await E.CACHE.get(GSYNC_KV.client))!).client_id).toBe(PANEL_ID);
  });

  it('valida: id sem sufixo do Google → 400; secret vazio → 400; json quebrado → 400', async () => {
    expect((await postClient({ client_id: 'qualquer-coisa', client_secret: 's' })).status).toBe(400);
    expect((await postClient({ client_id: PANEL_ID, client_secret: '   ' })).status).toBe(400);
    const bad = await handleGoogleClientPost(new Request('https://x/google/client', { method: 'POST', body: 'não-é-json' }), E);
    expect(bad.status).toBe(400);
    expect(await E.CACHE.get(GSYNC_KV.client)).toBeNull();
  });

  it('precedência: credencial do painel VENCE o env no refresh do sync', async () => {
    await postClient({ client_id: PANEL_ID, client_secret: 'kv-secret' });
    await connect();
    respondWith([gPerson()]);
    const r = await runGoogleSync(envG()); // env tem client-fake; KV tem PANEL_ID
    expect(r.ok).toBe(true);
    const tokenCall = fetchCalls.find((c) => c.url.startsWith(TOKEN_URL))!;
    expect(tokenCall.body).toContain(PANEL_ID);
    expect(tokenCall.body).not.toContain('client-fake');
  });

  it('trocar de client desconecta (grant antigo morre); mesmo id re-salvo não; google_links ficam', async () => {
    await postClient({ client_id: PANEL_ID, client_secret: 's1' });
    await connect();
    respondWith([gPerson()]);
    expect((await runGoogleSync({ ...E })).ok).toBe(true); // credencial SÓ do KV
    // mesmo id (ex.: secret regenerado) → conexão fica
    const same = (await (await postClient({ client_id: PANEL_ID, client_secret: 's2' })).json()) as any;
    expect(same.disconnected).toBe(false);
    expect(await E.CACHE.get(GSYNC_KV.oauth)).not.toBeNull();
    // id DIFERENTE → desconecta estado; vínculos ficam pro full sync reconciliar
    const other = (await (await postClient({ client_id: 'outro-999.apps.googleusercontent.com', client_secret: 's3' })).json()) as any;
    expect(other.disconnected).toBe(true);
    expect(await E.CACHE.get(GSYNC_KV.oauth)).toBeNull();
    expect(await E.CACHE.get(GSYNC_KV.syncToken)).toBeNull();
    expect(((await E.DB.prepare(`SELECT COUNT(*) AS n FROM google_links`).first()) as any).n).toBe(1);
  });

  it('clear remove a credencial do painel e desconecta se ela era a ativa', async () => {
    await postClient({ client_id: PANEL_ID, client_secret: 's1' });
    await connect();
    const res = (await (await postClient({ clear: true })).json()) as any;
    expect(res).toMatchObject({ ok: true, cleared: true, disconnected: true });
    expect(await E.CACHE.get(GSYNC_KV.client)).toBeNull();
    expect(await E.CACHE.get(GSYNC_KV.oauth)).toBeNull();
  });

  it('clear em modo env (sem credencial de painel) não desconecta', async () => {
    await connect();
    const res = (await (await postClient({ clear: true }, envG())).json()) as any;
    expect(res).toMatchObject({ ok: true, cleared: true, disconnected: false });
    expect(await E.CACHE.get(GSYNC_KV.oauth)).not.toBeNull();
  });

  it('connect-start funciona com credencial SÓ do painel (sem env)', async () => {
    await postClient({ client_id: PANEL_ID, client_secret: 's1' });
    const res = await handleGoogleConnectStart(new Request('https://contacts.test/google/connect-start', { method: 'POST' }), E);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.auth_url).toContain(PANEL_ID);
  });
});

describe('GET /google/status — configured/mode/máscara/callback_uri', () => {
  const PANEL_ID = 'panel-abc-123.apps.googleusercontent.com';
  const req = () => new Request('https://contacts.public.test/google/status');

  it('sem credencial nenhuma → configured:false, mode:null, callback_uri da origin real', async () => {
    const st = (await (await handleGoogleStatus(req(), E)).json()) as any;
    expect(st.configured).toBe(false);
    expect(st.mode).toBeNull();
    expect(st.client_id).toBeNull();
    expect(st.callback_uri).toBe('https://contacts.public.test/google/callback');
  });

  it('env → mode:env; painel salvo vence → mode:panel + id mascarado; secret nunca no payload', async () => {
    const stEnv = (await (await handleGoogleStatus(req(), envG())).json()) as any;
    expect(stEnv.configured).toBe(true);
    expect(stEnv.mode).toBe('env');
    await handleGoogleClientPost(new Request('https://x/google/client', { method: 'POST', body: JSON.stringify({ client_id: PANEL_ID, client_secret: 'segredo-kv' }) }), E);
    const stPanel = (await (await handleGoogleStatus(req(), envG())).json()) as any;
    expect(stPanel.mode).toBe('panel');
    expect(stPanel.client_id).toBe(`${PANEL_ID.slice(0, 12)}…`);
    expect(JSON.stringify(stPanel)).not.toContain('segredo-kv');
  });
});
