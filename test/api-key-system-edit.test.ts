// Edição tardia do campo `system` da chave (pedido 11/07): o agrupamento da
// listagem ("frota", "hermes"...) nascia na criação e ficava travado — agora é
// editável inline. Diferente do DONO (identidade, orphan-only por design), o
// sistema é só rótulo de organização: editável a qualquer momento em chave ativa.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { createApiKey, listApiKeys } from '../src/auth/api-keys.js';
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
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', cookie: ck },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM api_keys');
  await createUser(E, { id: 'user_castro', name: 'Bruno Castro', type: 'agent', bio: null, api_key_id: null }, 1);
});

describe('POST /app/api-keys/system', () => {
  it('atualiza o sistema de uma chave ativa e redireciona', async () => {
    const { row } = await createApiKey(E, E.OWNER_EMAIL, 'pat-a', 'full', 'user_castro');
    const res = await postForm('/app/api-keys/system', { id: row.id, system: 'hermes' }, await cookie());
    expect(res.status).toBe(302);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys.find((k) => k.id === row.id)?.system).toBe('hermes');
  });

  it('sistema vazio limpa (volta pro grupo "Sem sistema")', async () => {
    const { row } = await createApiKey(E, E.OWNER_EMAIL, 'pat-b', 'full', 'user_castro', 'frota');
    const res = await postForm('/app/api-keys/system', { id: row.id, system: '   ' }, await cookie());
    expect(res.status).toBe(302);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys.find((k) => k.id === row.id)?.system).toBeNull();
  });

  it('chave revogada → 400, sistema intacto', async () => {
    const { row } = await createApiKey(E, E.OWNER_EMAIL, 'pat-c', 'full', 'user_castro', 'frota');
    await E.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).bind(Date.now(), row.id).run();
    const res = await postForm('/app/api-keys/system', { id: row.id, system: 'hermes' }, await cookie());
    expect(res.status).toBe(400);
    const keys = await listApiKeys(E, E.OWNER_EMAIL);
    expect(keys.find((k) => k.id === row.id)?.system).toBe('frota');
  });

  it('id ausente ou inexistente → 400; sem sessão → redirect de login', async () => {
    const ck = await cookie();
    expect((await postForm('/app/api-keys/system', { system: 'x' }, ck)).status).toBe(400);
    expect((await postForm('/app/api-keys/system', { id: 'key_fantasma', system: 'x' }, ck)).status).toBe(400);
    const anon = await SELF.fetch('https://x/app/api-keys/system', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=x&system=y',
    });
    expect([302, 303, 401]).toContain(anon.status);
  });
});

describe('listagem redesenhada (/app/config)', () => {
  it('chave ativa rende key-row com form de editar sistema; revogada não', async () => {
    const a = await createApiKey(E, E.OWNER_EMAIL, 'pat-viva', 'full', 'user_castro', 'frota');
    const b = await createApiKey(E, E.OWNER_EMAIL, 'pat-morta', 'full', 'user_castro', 'frota');
    await E.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).bind(Date.now(), b.row.id).run();

    const html = await (await SELF.fetch('https://x/app/config', { headers: { cookie: await cookie() } })).text();
    expect(html).toContain('class="key-row');
    expect(html).toContain(`action="/app/api-keys/system"`);
    expect(html).toContain(`name="id" value="${a.row.id}"`);
    // O form de sistema existe SÓ pra chave ativa (1 na tela toda).
    expect(html.split('action="/app/api-keys/system"').length - 1).toBe(1);
    // Input pré-preenchido com o sistema atual + datalist dos conhecidos.
    expect(html).toMatch(/name="system"[^>]*value="frota"[^>]*list="key-systems"|list="key-systems"[^>]*value="frota"/);
  });
});
