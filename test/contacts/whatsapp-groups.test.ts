import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../src/contacts/db/migrate';
import { importWaGroups, sanitizeCatalog, WAGROUPS_KV, WAGROUPS_WHY_PREFIX } from '../../src/contacts/whatsapp/sync';
import { requireWaSyncAuth, handleWaStatus, handleWaAllowlistPost, handleWaImport, handleWaCreateMembersPost } from '../../src/contacts/whatsapp/routes';
import { proxyTokenAllowsPath, writeTokenAllowsPath } from '../../src/contacts/auth/tokens';

// Integração OPCIONAL WhatsApp Agent → grupos (specs/whatsapp-groups-sync.md).
// Dados 100% fictícios (repo público): Ana Almeida, Bruno Castro, Grupo Mentoria.

const E = env as any;

const CHAT_A = '120363111111111111-group';
const CHAT_B = '120363222222222222-group';

const seedPerson = async (id: string, name: string, phone: string | null) => {
  await E.DB.prepare(
    `INSERT OR REPLACE INTO entities (id, kind, name, phone, source) VALUES (?, 'person', ?, ?, 'seed')`
  ).bind(id, name, phone).run();
};

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await E.CACHE.delete(WAGROUPS_KV.catalog);
  await E.CACHE.delete(WAGROUPS_KV.allowlist);
  await E.CACHE.delete(WAGROUPS_KV.lastRun);
  await E.CACHE.delete(WAGROUPS_KV.createMembers);
});

describe('allowlists de token (src/auth/tokens.ts)', () => {
  it('proxy token lê /whatsapp/status; write token grava /whatsapp/allowlist; resto fechado', () => {
    expect(proxyTokenAllowsPath('/whatsapp/status')).toBe(true);
    expect(writeTokenAllowsPath('/whatsapp/allowlist')).toBe(true);
    expect(proxyTokenAllowsPath('/whatsapp/allowlist')).toBe(false);
    expect(writeTokenAllowsPath('/whatsapp/status')).toBe(false);
    expect(proxyTokenAllowsPath('/whatsapp/groups/import')).toBe(false);
    expect(writeTokenAllowsPath('/whatsapp/groups/import')).toBe(false);
  });
});

describe('requireWaSyncAuth — integração opcional de verdade', () => {
  const reqWith = (bearer?: string) =>
    new Request('https://x/whatsapp/groups/import', {
      method: 'POST',
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

  it('sem WHATSAPP_SYNC_TOKEN configurado → 503 (desligada)', async () => {
    const res = requireWaSyncAuth(reqWith('qualquer'), { ...E, WHATSAPP_SYNC_TOKEN: undefined });
    expect(res?.status).toBe(503);
  });

  it('token errado → 401; token certo ou OWNER_TOKEN → autorizado', () => {
    const envW = { ...E, WHATSAPP_SYNC_TOKEN: 'wa-tok-fake', OWNER_TOKEN: 'owner-fake' };
    expect(requireWaSyncAuth(reqWith('errado'), envW)?.status).toBe(401);
    expect(requireWaSyncAuth(reqWith(), envW)?.status).toBe(401);
    expect(requireWaSyncAuth(reqWith('wa-tok-fake'), envW)).toBeNull();
    expect(requireWaSyncAuth(reqWith('owner-fake'), envW)).toBeNull();
  });
});

describe('sanitizeCatalog', () => {
  it('valida shape, corta entrada sem chat_id/name e normaliza member_count', () => {
    expect(sanitizeCatalog({})).toBeNull();
    expect(sanitizeCatalog({ groups: 'x' })).toBeNull();
    const out = sanitizeCatalog({
      groups: [
        { chat_id: CHAT_A, name: 'Grupo Mentoria (ficticio)', member_count: 3.7 },
        { chat_id: '', name: 'sem id' },
        { name: 'sem chat_id' },
        { chat_id: CHAT_B, name: '  Grupo Beta  ', member_count: -1 },
      ],
    });
    expect(out).toEqual([
      { chat_id: CHAT_A, name: 'Grupo Mentoria (ficticio)', member_count: 3 },
      { chat_id: CHAT_B, name: 'Grupo Beta', member_count: null },
    ]);
  });
});

describe('importWaGroups — engine', () => {
  it('grupo fora da allowlist é pulado (dupla checagem server-side)', async () => {
    const r = await importWaGroups(E, [
      { chat_id: CHAT_A, name: 'Grupo Fora', participants: [{ phone: '5511911112222' }] },
    ]);
    expect(r.groups_imported).toBe(0);
    expect(r.skipped_not_allowlisted).toBe(1);
    const grp = await E.DB.prepare(`SELECT id FROM entities WHERE name = 'Grupo Fora'`).first();
    expect(grp).toBeNull();
  });

  it('cria entidade group, vincula SÓ persons existentes (variantes de telefone) e conta não-mapeados', async () => {
    const pa = crypto.randomUUID(), pb = crypto.randomUUID();
    // Ana salva SEM o 9º dígito — o participante chega COM; variantes casam.
    await seedPerson(pa, 'Ana Almeida', '551133334444');
    await seedPerson(pb, 'Bruno Castro', '5511955556666');
    await E.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify([CHAT_A]));

    const r = await importWaGroups(E, [{
      chat_id: CHAT_A,
      name: 'Grupo Mentoria (ficticio)',
      participants: [
        { phone: '5511933334444', name: 'Ana Almeida' },
        { phone: '5511955556666', name: 'Bruno Castro' },
        { phone: '5599900001111', name: 'Desconhecido X' },
      ],
    }]);

    expect(r.groups_imported).toBe(1);
    expect(r.members_linked).toBe(2);
    expect(r.unmatched).toBe(1);
    expect(r.unmatched_sample).toEqual(['Desconhecido X']);

    const grp = await E.DB.prepare(
      `SELECT id, kind, source, private FROM entities WHERE name = 'Grupo Mentoria (ficticio)'`
    ).first();
    expect(grp?.kind).toBe('group');
    expect(grp?.source).toBe('whatsapp');
    expect(grp?.private).toBe(0);

    const link = await E.DB.prepare(`SELECT entity_id FROM whatsapp_links WHERE chat_id = ?`).bind(CHAT_A).first();
    expect(link?.entity_id).toBe(grp?.id);

    const conns = (await E.DB.prepare(
      `SELECT a_id, b_id, type, why FROM connections WHERE type = 'member_of' AND b_id = ?`
    ).bind(grp?.id).all()).results;
    expect(conns.length).toBe(2);
    expect(new Set(conns.map((c: any) => c.a_id))).toEqual(new Set([pa, pb]));
    for (const c of conns) expect(String(c.why).startsWith(WAGROUPS_WHY_PREFIX)).toBe(true);
    // desconhecido NÃO virou entidade
    const ghost = await E.DB.prepare(`SELECT id FROM entities WHERE phone = '5599900001111'`).first();
    expect(ghost).toBeNull();
  });

  it('re-import é replace-set: membro que saiu perde o vínculo DO SYNC; edge manual fica; rename atualiza', async () => {
    const pa = crypto.randomUUID(), pb = crypto.randomUUID(), pm = crypto.randomUUID();
    await seedPerson(pa, 'Ana Almeida', '5511911110001');
    await seedPerson(pb, 'Bruno Castro', '5511911110002');
    await seedPerson(pm, 'Carla Souza', '5511911110003');
    await E.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify([CHAT_B]));

    await importWaGroups(E, [{
      chat_id: CHAT_B, name: 'Grupo Beta',
      participants: [{ phone: '5511911110001' }, { phone: '5511911110002' }],
    }]);
    const grp = await E.DB.prepare(`SELECT id FROM entities WHERE name = 'Grupo Beta'`).first();

    // edge MANUAL de member_of (why sem o marcador do sync)
    await E.DB.prepare(
      `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, 'member_of', 0.5, ?)`
    ).bind(crypto.randomUUID(), pm, grp.id, 'vinculo manual criado pelo dono no console').run();

    // 2º import: Ana saiu, grupo renomeado
    const r2 = await importWaGroups(E, [{
      chat_id: CHAT_B, name: 'Grupo Beta Renomeado',
      participants: [{ phone: '5511911110002' }],
    }]);
    expect(r2.members_unlinked).toBe(1);
    expect(r2.members_linked).toBe(0); // Bruno já estava

    const renamed = await E.DB.prepare(`SELECT name FROM entities WHERE id = ?`).bind(grp.id).first();
    expect(renamed?.name).toBe('Grupo Beta Renomeado');

    const conns = (await E.DB.prepare(
      `SELECT a_id FROM connections WHERE type = 'member_of' AND b_id = ?`
    ).bind(grp.id).all()).results.map((c: any) => c.a_id);
    expect(new Set(conns)).toEqual(new Set([pb, pm])); // Bruno (sync) + Carla (manual)
  });
});

describe('toggle create_members — membro desconhecido vira contato (default OFF)', () => {
  const participants = [
    { phone: '5511900010001', name: 'Carla Dias' },
    { phone: '5511900010002', name: null },
  ];

  it('default OFF: desconhecido NÃO cria entidade e conta em unmatched', async () => {
    await E.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify([CHAT_A]));
    const r = await importWaGroups(E, [{ chat_id: CHAT_A, name: 'Grupo Toggle Off (ficticio)', participants }]);
    expect(r.members_created).toBe(0);
    expect(r.unmatched).toBe(2);
    const ghost = await E.DB.prepare(`SELECT id FROM entities WHERE phone = '5511900010001'`).first();
    expect(ghost).toBeNull();
  });

  it('ON: cria person source=whatsapp com canal phone primário, vincula member_of e sai do unmatched', async () => {
    await E.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify([CHAT_A]));
    await E.CACHE.put(WAGROUPS_KV.createMembers, '1');
    const r = await importWaGroups(E, [{ chat_id: CHAT_A, name: 'Grupo Toggle On (ficticio)', participants }]);
    expect(r.members_created).toBe(2);
    expect(r.members_linked).toBe(2);
    expect(r.unmatched).toBe(0);
    expect(r.creation_capped).toBe(0);

    const p = await E.DB.prepare(
      `SELECT id, name, source, private FROM entities WHERE phone = '5511900010001'`
    ).first();
    expect(p?.name).toBe('Carla Dias');
    expect(p?.source).toBe('whatsapp');
    expect(p?.private).toBe(0);
    // sem nome no WhatsApp → o telefone vira o nome de exibição
    const anon = await E.DB.prepare(`SELECT name FROM entities WHERE phone = '5511900010002'`).first();
    expect(anon?.name).toBe('5511900010002');

    const ch = await E.DB.prepare(
      `SELECT kind, value, is_primary FROM entity_channels WHERE entity_id = ?`
    ).bind(p?.id).first();
    expect(ch?.kind).toBe('phone');
    expect(ch?.value).toBe('5511900010001');
    expect(ch?.is_primary).toBe(1);

    const conn = await E.DB.prepare(
      `SELECT why FROM connections WHERE type = 'member_of' AND a_id = ?`
    ).bind(p?.id).first();
    expect(String(conn?.why).startsWith(WAGROUPS_WHY_PREFIX)).toBe(true);
  });

  it('ON: mesma pessoa em 2 grupos na mesma request cria UMA entidade com 2 vínculos', async () => {
    await E.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify([CHAT_A, CHAT_B]));
    await E.CACHE.put(WAGROUPS_KV.createMembers, '1');
    const dup = { phone: '5511900020009', name: 'Bruno Castro' };
    const r = await importWaGroups(E, [
      { chat_id: CHAT_A, name: 'Grupo Dedupe A (ficticio)', participants: [dup] },
      // No segundo grupo o MESMO número chega sem o 9º dígito (variante).
      { chat_id: CHAT_B, name: 'Grupo Dedupe B (ficticio)', participants: [{ phone: '551100020009', name: 'Bruno Castro' }] },
    ]);
    expect(r.members_created).toBe(1);
    const rows = (await E.DB.prepare(
      `SELECT id FROM entities WHERE name = 'Bruno Castro' AND source = 'whatsapp'`
    ).all()).results;
    expect(rows.length).toBe(1);
    const conns = (await E.DB.prepare(
      `SELECT id FROM connections WHERE type = 'member_of' AND a_id = ?`
    ).bind(rows[0].id).all()).results;
    expect(conns.length).toBe(2);
  });

  it('rota do painel grava o flag e o status reflete; allowlist de token só no write', async () => {
    expect(writeTokenAllowsPath('/whatsapp/create-members')).toBe(true);
    expect(proxyTokenAllowsPath('/whatsapp/create-members')).toBe(false);

    const bad = await handleWaCreateMembersPost(
      new Request('https://x/whatsapp/create-members', { method: 'POST', body: JSON.stringify({ enabled: 'sim' }) }), E
    );
    expect(bad.status).toBe(400);

    const ok = await handleWaCreateMembersPost(
      new Request('https://x/whatsapp/create-members', { method: 'POST', body: JSON.stringify({ enabled: true }) }), E
    );
    expect((await ok.json() as any).create_members).toBe(true);
    const st = await (await handleWaStatus(E)).json() as any;
    expect(st.create_members).toBe(true);

    const off = await handleWaCreateMembersPost(
      new Request('https://x/whatsapp/create-members', { method: 'POST', body: JSON.stringify({ enabled: false }) }), E
    );
    expect((await off.json() as any).create_members).toBe(false);
  });
});

describe('rotas do painel', () => {
  it('handleWaAllowlistPost valida e grava; handleWaStatus reflete catálogo/allowlist/configured', async () => {
    // Nunca salvou → allowlist_set false (painel pré-marca tudo nesse estado).
    const st0 = await (await handleWaStatus({ ...E, WHATSAPP_SYNC_TOKEN: 'wa-tok-fake' })).json() as any;
    expect(st0.allowlist_set).toBe(false);

    const bad = await handleWaAllowlistPost(
      new Request('https://x/whatsapp/allowlist', { method: 'POST', body: JSON.stringify({ chat_ids: [1] }) }), E,
    );
    expect(bad.status).toBe(400);

    const ok = await handleWaAllowlistPost(
      new Request('https://x/whatsapp/allowlist', { method: 'POST', body: JSON.stringify({ chat_ids: [CHAT_A] }) }), E,
    );
    expect(ok.status).toBe(200);

    await E.CACHE.put(WAGROUPS_KV.catalog, JSON.stringify({
      groups: [{ chat_id: CHAT_A, name: 'Grupo Mentoria (ficticio)', member_count: 3 }],
      pushed_at: '2026-07-08T12:00:00Z',
    }));

    const status = await (await handleWaStatus({ ...E, WHATSAPP_SYNC_TOKEN: 'wa-tok-fake' })).json() as any;
    expect(status.ok).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.allowlist).toEqual([CHAT_A]);
    expect(status.allowlist_set).toBe(true);
    expect(status.catalog[0].name).toBe('Grupo Mentoria (ficticio)');
    // o token NUNCA aparece na resposta
    expect(JSON.stringify(status)).not.toContain('wa-tok-fake');

    const off = await (await handleWaStatus({ ...E, WHATSAPP_SYNC_TOKEN: undefined })).json() as any;
    expect(off.configured).toBe(false);
  });

  it('handleWaImport valida payload (grupo sem chat_id/name → 400)', async () => {
    const res = await handleWaImport(
      new Request('https://x/whatsapp/groups/import', { method: 'POST', body: JSON.stringify({ groups: [{ name: 'sem id' }] }) }), E,
    );
    expect(res.status).toBe(400);
  });
});
