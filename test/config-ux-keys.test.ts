// UX de credenciais no /app/config (spec 80-frota-agentes/87). O bug do PC assinando
// como Claude VPS nasceu da tela antiga: chave órfã + vínculo em 2 passos + zero
// visibilidade de uso. Aqui: coluna `system` (agrupamento), whoami (a máquina confere
// a própria identidade num curl), throttle do last_used_at (máx 1 escrita/h por chave
// via KV) e listagem com dono/último uso/selo dormindo + banner one-time.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { createApiKey, listApiKeys, validateApiKey } from '../src/auth/api-keys.js';
import { signSession } from '../src/web/session.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function postForm(path: string, fields: Record<string, string>, ck: string): Promise<Response> {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck },
    body: new URLSearchParams(fields).toString(),
  });
}

const whoami = (key?: string) =>
  SELF.fetch('https://x.test/api/whoami', { headers: key ? { authorization: `Bearer ${key}` } : {} });

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('migration 0023_api_key_meta', () => {
  it('api_keys.system existe (last_used_at já existia desde a 0003)', async () => {
    const cols = (await E.DB.prepare(`PRAGMA table_info(api_keys)`).all()).results.map((r: any) => r.name);
    expect(cols).toContain('system');
    expect(cols).toContain('last_used_at');
  });
});

describe('criação de chave com sistema', () => {
  it('form grava system; listApiKeys devolve', async () => {
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: null }, 1);
    const res = await postForm('/app/api-keys/create', {
      name: 'pat-vps', scope: 'full', user_id: 'user_vps', system: 'frota',
    }, await cookie());
    expect(res.status).toBe(302);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys[0].system).toBe('frota');
  });

  it('system é opcional (chave sem sistema nasce com null)', async () => {
    await createUser(E, { id: 'user_x', name: 'X', type: 'agent', bio: null, api_key_id: null }, 1);
    const res = await postForm('/app/api-keys/create', { name: 'solta', scope: 'full', user_id: 'user_x' }, await cookie());
    expect(res.status).toBe(302);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys[0].system).toBeNull();
  });
});

describe('GET /api/whoami', () => {
  it('chave vinculada devolve key_name + user + scopes; no-store', async () => {
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: null }, 1);
    const { plainKey } = await createApiKey(E, E.OWNER_EMAIL, 'pat-vps-backup', 'full,private', 'user_vps');
    const res = await whoami(plainKey);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body: any = await res.json();
    expect(body.key_name).toBe('pat-vps-backup');
    expect(body.user).toEqual({ id: 'user_vps', name: 'Claude VPS', type: 'agent' });
    expect(body.scopes).toBe('full,private');
  });

  it('chave SEM dono → 200 com user null (diagnóstico, não erro)', async () => {
    const { plainKey } = await createApiKey(E, E.OWNER_EMAIL, 'orfa', 'full', null);
    const res = await whoami(plainKey);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.key_name).toBe('orfa');
    expect(body.user).toBeNull();
  });

  it('sem PAT → 401; PAT inválido → 401', async () => {
    expect((await whoami()).status).toBe(401);
    expect((await whoami('eb_pat_nope')).status).toBe(401);
  });
});

describe('throttle do last_used_at (máx 1 escrita/h por chave)', () => {
  it('segunda validação na mesma hora NÃO regrava last_used_at', async () => {
    await createUser(E, { id: 'user_a', name: 'A', type: 'agent', bio: null, api_key_id: null }, 1);
    const { row, plainKey } = await createApiKey(E, E.OWNER_EMAIL, 'throttled', 'full', 'user_a');

    expect(await validateApiKey(E, plainKey)).toBeTruthy();
    // O touch do 1º validate é fire-and-forget — dá um tick pra ele assentar antes
    // de congelar o sentinela (senão a escrita atrasada engoliria o 12345).
    await new Promise((r) => setTimeout(r, 25));
    // Congela um valor sentinela; se a 2ª validação regravar, o sentinela some.
    await E.DB.prepare(`UPDATE api_keys SET last_used_at = 12345 WHERE id = ?`).bind(row.id).run();
    expect(await validateApiKey(E, plainKey)).toBeTruthy();
    const after = await E.DB.prepare(`SELECT last_used_at FROM api_keys WHERE id = ?`).bind(row.id).first();
    expect(after.last_used_at).toBe(12345);

    // Janela expirada (flag do KV removida) → volta a gravar.
    await E.OAUTH_KV.delete(`pat_touch:${row.id}`);
    expect(await validateApiKey(E, plainKey)).toBeTruthy();
    const fresh = await E.DB.prepare(`SELECT last_used_at FROM api_keys WHERE id = ?`).bind(row.id).first();
    expect(fresh.last_used_at).toBeGreaterThan(12345);
  });
});

describe('POST /app/api-keys/owner — vincular dono em chave órfã', () => {
  it('órfã ativa + usuário ativo → vincula e redireciona', async () => {
    await createUser(E, { id: 'user_pc', name: 'PC Desktop', type: 'agent', bio: null, api_key_id: null }, 1);
    const { row } = await createApiKey(E, E.OWNER_EMAIL, 'pat-orfa', 'full', null);
    const res = await postForm('/app/api-keys/owner', { id: row.id, user_id: 'user_pc' }, await cookie());
    expect(res.status).toBe(302);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys.find((k) => k.id === row.id)?.user_id).toBe('user_pc');
  });

  it('chave que JÁ tem dono não é re-apontada (400, dono intacto)', async () => {
    await createUser(E, { id: 'user_a', name: 'A', type: 'agent', bio: null, api_key_id: null }, 1);
    await createUser(E, { id: 'user_b', name: 'B', type: 'agent', bio: null, api_key_id: null }, 1);
    const { row } = await createApiKey(E, E.OWNER_EMAIL, 'pat-fixa', 'full', 'user_a');
    const res = await postForm('/app/api-keys/owner', { id: row.id, user_id: 'user_b' }, await cookie());
    expect(res.status).toBe(400);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys.find((k) => k.id === row.id)?.user_id).toBe('user_a');
  });

  it('usuário inexistente/arquivado → 400; chave revogada → 400', async () => {
    const { row } = await createApiKey(E, E.OWNER_EMAIL, 'pat-x', 'full', null);
    const ck = await cookie();
    expect((await postForm('/app/api-keys/owner', { id: row.id, user_id: 'user_fantasma' }, ck)).status).toBe(400);

    await createUser(E, { id: 'user_ok', name: 'Ok', type: 'agent', bio: null, api_key_id: null }, 1);
    await E.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).bind(Date.now(), row.id).run();
    expect((await postForm('/app/api-keys/owner', { id: row.id, user_id: 'user_ok' }, ck)).status).toBe(400);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys.find((k) => k.id === row.id)?.user_id).toBeNull();
  });
});

describe('/app/config — banner one-time e listagem agrupada', () => {
  it('banner da chave recém-criada tem copiar + "já salvei" (fecha só por ele)', async () => {
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: null }, 1);
    const ck = await cookie();
    const create = await postForm('/app/api-keys/create', {
      name: 'pat-banner', scope: 'full', user_id: 'user_vps', system: 'frota',
    }, ck);
    const loc = create.headers.get('location')!;
    const page = await SELF.fetch(`https://x${loc}`, { headers: { cookie: ck } });
    const html = await page.text();
    expect(html).toContain('id="key-flash"');
    expect(html).toContain('data-copy="key-flash-value"');
    expect(html).toContain('id="key-flash-ack"');
    expect(html).toContain('eb_pat_'); // o token em si, uma única vez

    // Recarregar SEM o flash: token não re-exibível.
    const again = await SELF.fetch('https://x/app/config', { headers: { cookie: ck } });
    expect(await again.text()).not.toContain('id="key-flash"');
  });

  it('listagem agrupa por sistema (frota primeiro), mostra dono e selo dormindo em 30+ dias', async () => {
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: null }, 1);
    const a = await createApiKey(E, E.OWNER_EMAIL, 'pat-frota-vps', 'full', 'user_vps');
    await E.DB.prepare(`UPDATE api_keys SET system = 'frota', last_used_at = ? WHERE id = ?`)
      .bind(Date.now() - 2 * 3600_000, a.row.id).run();
    const b = await createApiKey(E, E.OWNER_EMAIL, 'pat-hermes', 'full', null);
    await E.DB.prepare(`UPDATE api_keys SET system = 'hermes', last_used_at = ? WHERE id = ?`)
      .bind(Date.now() - 40 * 24 * 3600_000, b.row.id).run();

    const html = await (await SELF.fetch('https://x/app/config', { headers: { cookie: await cookie() } })).text();
    // Grupos por sistema, frota antes de hermes.
    const iFrota = html.indexOf('data-key-group="frota"');
    const iHermes = html.indexOf('data-key-group="hermes"');
    expect(iFrota).toBeGreaterThan(-1);
    expect(iHermes).toBeGreaterThan(iFrota);
    // Dono na listagem + selo dormindo na chave parada há 40 dias.
    expect(html).toContain('Claude VPS');
    expect(html).toContain('dormindo');
  });

  it('chave órfã ativa mostra o form de vincular dono; chave com dono não', async () => {
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: null }, 1);
    const orfa = await createApiKey(E, E.OWNER_EMAIL, 'pat-orfa', 'full', null);
    await createApiKey(E, E.OWNER_EMAIL, 'pat-com-dono', 'full', 'user_vps');
    const html = await (await SELF.fetch('https://x/app/config', { headers: { cookie: await cookie() } })).text();
    expect(html).toContain('action="/app/api-keys/owner"');
    expect(html).toContain(`name="id" value="${orfa.row.id}"`);
    // Só 1 form de vínculo (o da órfã) — a chave com dono rende texto simples.
    expect(html.split('action="/app/api-keys/owner"').length - 1).toBe(1);
  });

  it('chaves revogadas ficam colapsadas num details próprio', async () => {
    const k = await createApiKey(E, E.OWNER_EMAIL, 'efemera-backfill', 'full', null);
    await E.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).bind(Date.now(), k.row.id).run();
    const html = await (await SELF.fetch('https://x/app/config', { headers: { cookie: await cookie() } })).text();
    expect(html).toContain('id="keys-revoked"');
    // O nome da chave revogada mora DENTRO do details colapsado.
    const details = html.slice(html.indexOf('id="keys-revoked"'));
    expect(details).toContain('efemera-backfill');
  });
});
