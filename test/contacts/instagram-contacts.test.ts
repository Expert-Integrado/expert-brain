import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../src/contacts/db/migrate';
import { importIgContacts, sanitizeIgCatalog, normalizeIgUsername, IGCONTACTS_KV } from '../../src/contacts/instagram/sync';
import { requireIgSyncAuth, handleIgStatus, handleIgAllowlistPost } from '../../src/contacts/instagram/routes';
import { proxyTokenAllowsPath, writeTokenAllowsPath } from '../../src/contacts/auth/tokens';

// Integração OPCIONAL Instagram Agent → contatos (specs/instagram-contacts-sync.md).
// Dados 100% fictícios (repo público): Ana Almeida, Bruno Castro.

const E = env as any;

const SID_A = 'igsid-1111';
const SID_B = 'igsid-2222';
const SID_C = 'igsid-3333';

const seedPerson = async (id: string, name: string, phone: string | null) => {
  await E.DB.prepare(
    `INSERT OR REPLACE INTO entities (id, kind, name, phone, source) VALUES (?, 'person', ?, ?, 'seed')`
  ).bind(id, name, phone).run();
};

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await E.CACHE.delete(IGCONTACTS_KV.catalog);
  await E.CACHE.delete(IGCONTACTS_KV.allowlist);
  await E.CACHE.delete(IGCONTACTS_KV.lastRun);
  await E.DB.prepare(`DELETE FROM instagram_links WHERE igsid IN (?, ?, ?)`).bind(SID_A, SID_B, SID_C).run();
});

describe('allowlists de token e auth do script', () => {
  it('proxy lê /instagram/status; write grava /instagram/allowlist; resto fechado', () => {
    expect(proxyTokenAllowsPath('/instagram/status')).toBe(true);
    expect(writeTokenAllowsPath('/instagram/allowlist')).toBe(true);
    expect(proxyTokenAllowsPath('/instagram/allowlist')).toBe(false);
    expect(writeTokenAllowsPath('/instagram/contacts/import')).toBe(false);
  });

  it('sem INSTAGRAM_SYNC_TOKEN → 503; bearer errado → 401; certo/OWNER → ok', () => {
    const reqWith = (b?: string) => new Request('https://x/instagram/contacts/import', {
      method: 'POST', headers: b ? { authorization: `Bearer ${b}` } : {},
    });
    expect(requireIgSyncAuth(reqWith('x'), { ...E, INSTAGRAM_SYNC_TOKEN: undefined })?.status).toBe(503);
    const envI = { ...E, INSTAGRAM_SYNC_TOKEN: 'ig-tok-fake', OWNER_TOKEN: 'owner-fake' };
    expect(requireIgSyncAuth(reqWith('errado'), envI)?.status).toBe(401);
    expect(requireIgSyncAuth(reqWith('ig-tok-fake'), envI)).toBeNull();
    expect(requireIgSyncAuth(reqWith('owner-fake'), envI)).toBeNull();
  });
});

describe('normalização', () => {
  it('normalizeIgUsername tira @, baixa caixa e valida alfabeto', () => {
    expect(normalizeIgUsername('@Ana.Almeida_1')).toBe('ana.almeida_1');
    expect(normalizeIgUsername('tem espaço')).toBeNull();
    expect(normalizeIgUsername(42)).toBeNull();
  });

  it('sanitizeIgCatalog exige igsid e alguma identidade (username ou name)', () => {
    expect(sanitizeIgCatalog({})).toBeNull();
    const out = sanitizeIgCatalog({ contacts: [
      { igsid: SID_A, username: '@Ana_Oficial', name: 'Ana Almeida', follower_count: 12.9 },
      { igsid: '', username: 'sem_sid' },
      { igsid: 'sid-sem-identidade' },
    ]});
    expect(out).toEqual([{ igsid: SID_A, username: 'ana_oficial', name: 'Ana Almeida', follower_count: 12 }]);
  });
});

describe('importIgContacts — engine', () => {
  it('fora da allowlist é pulado', async () => {
    const r = await importIgContacts(E, [{ igsid: SID_A, username: 'fora_da_lista' }]);
    expect(r.imported).toBe(0);
    expect(r.skipped_not_allowlisted).toBe(1);
  });

  it('match por telefone vincula existente (canal + link) SEM sobrescrever nome', async () => {
    const pa = crypto.randomUUID();
    await seedPerson(pa, 'Ana Almeida', '5511922220001');
    await E.CACHE.put(IGCONTACTS_KV.allowlist, JSON.stringify([SID_A]));

    const r = await importIgContacts(E, [
      { igsid: SID_A, username: '@Ana_Oficial', name: 'ana ig nome diferente', phone: '5511922220001' },
    ]);
    expect(r.linked_existing).toBe(1);
    expect(r.created).toBe(0);

    const ent = await E.DB.prepare(`SELECT name FROM entities WHERE id = ?`).bind(pa).first();
    expect(ent?.name).toBe('Ana Almeida'); // nome local intocado
    const link = await E.DB.prepare(`SELECT entity_id FROM instagram_links WHERE igsid = ?`).bind(SID_A).first();
    expect(link?.entity_id).toBe(pa);
    const ch = await E.DB.prepare(
      `SELECT value FROM entity_channels WHERE entity_id = ? AND kind = 'instagram'`
    ).bind(pa).first();
    expect(ch?.value).toBe('ana_oficial');
  });

  it('sem match cria person source=instagram com canal @ e telefone quando houver', async () => {
    await E.CACHE.put(IGCONTACTS_KV.allowlist, JSON.stringify([SID_B, SID_C]));
    const r = await importIgContacts(E, [
      { igsid: SID_B, username: '@bruno_novo', name: 'Bruno Castro' },
      { igsid: SID_C, username: null, name: null }, // sem identidade → skip
    ]);
    expect(r.created).toBe(1);
    expect(r.skipped_no_identity).toBe(1);

    const link = await E.DB.prepare(`SELECT entity_id FROM instagram_links WHERE igsid = ?`).bind(SID_B).first();
    const ent = await E.DB.prepare(`SELECT name, kind, source FROM entities WHERE id = ?`).bind(link?.entity_id).first();
    expect(ent).toMatchObject({ name: 'Bruno Castro', kind: 'person', source: 'instagram' });
  });

  it('re-import do mesmo igsid não duplica (resolve pelo vínculo salvo)', async () => {
    await E.CACHE.put(IGCONTACTS_KV.allowlist, JSON.stringify([SID_B]));
    await importIgContacts(E, [{ igsid: SID_B, username: 'bruno_novo', name: 'Bruno Castro' }]);
    const r2 = await importIgContacts(E, [{ igsid: SID_B, username: 'bruno_novo', name: 'Bruno Castro' }]);
    expect(r2.created).toBe(0);
    expect(r2.linked_existing).toBe(1);
    const n = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM entities WHERE name = 'Bruno Castro' AND source = 'instagram'`
    ).first();
    expect(n?.n).toBe(1);
  });

  it('match por canal instagram existente vincula sem criar', async () => {
    const pb = crypto.randomUUID();
    await seedPerson(pb, 'Carla Souza', null);
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'carla.souza', 0)`
    ).bind(crypto.randomUUID(), pb).run();
    await E.CACHE.put(IGCONTACTS_KV.allowlist, JSON.stringify([SID_C]));

    const r = await importIgContacts(E, [{ igsid: SID_C, username: '@Carla.Souza' }]);
    expect(r.linked_existing).toBe(1);
    const link = await E.DB.prepare(`SELECT entity_id FROM instagram_links WHERE igsid = ?`).bind(SID_C).first();
    expect(link?.entity_id).toBe(pb);
  });
});

describe('rotas do painel', () => {
  it('allowlist valida e grava; status reflete catálogo/configured sem vazar token', async () => {
    // Nunca salvou → allowlist_set false (painel pré-marca tudo nesse estado).
    const st0 = await (await handleIgStatus({ ...E, INSTAGRAM_SYNC_TOKEN: 'ig-tok-fake' })).json() as any;
    expect(st0.allowlist_set).toBe(false);

    const bad = await handleIgAllowlistPost(
      new Request('https://x/instagram/allowlist', { method: 'POST', body: JSON.stringify({ igsids: [1] }) }), E,
    );
    expect(bad.status).toBe(400);
    const ok = await handleIgAllowlistPost(
      new Request('https://x/instagram/allowlist', { method: 'POST', body: JSON.stringify({ igsids: [SID_A] }) }), E,
    );
    expect(ok.status).toBe(200);

    await E.CACHE.put(IGCONTACTS_KV.catalog, JSON.stringify({
      contacts: [{ igsid: SID_A, username: 'ana_oficial', name: 'Ana Almeida', follower_count: 10 }],
      pushed_at: '2026-07-08T12:00:00Z',
    }));
    const st = await (await handleIgStatus({ ...E, INSTAGRAM_SYNC_TOKEN: 'ig-tok-fake' })).json() as any;
    expect(st.ok).toBe(true);
    expect(st.configured).toBe(true);
    expect(st.allowlist).toEqual([SID_A]);
    expect(st.allowlist_set).toBe(true);
    expect(st.catalog[0].username).toBe('ana_oficial');
    expect(JSON.stringify(st)).not.toContain('ig-tok-fake');
    const off = await (await handleIgStatus({ ...E, INSTAGRAM_SYNC_TOKEN: undefined })).json() as any;
    expect(off.configured).toBe(false);
  });
});
