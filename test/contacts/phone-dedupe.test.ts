import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/contacts/db/migrate';
import { importWaGroups, WAGROUPS_KV } from '../../src/contacts/whatsapp/sync';

// Fix do bug de duplicação por telefone (pré-requisito da categoria mapeado,
// nota fh39xlmxi973): a DEDUPE de criação precisa espelhar o LOOKUP —
// get_contact_by_phone resolve pela coluna E por entity_channels, mas o
// save_person/matchParticipants só olhavam a coluna. Número que vive como canal
// secundário criava entidade duplicada.

const OWNER = 'test-owner-token';
const authHeaders = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' };
const E = env as any;

function post(path: string, body: unknown) {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}

let phoneSeq = 0;
const nextPhone = () => `5531${String(900000000 + phoneSeq++).padStart(9, '0')}`;

beforeAll(async () => {
  await runMigrations(E);
});

describe('save_person — dedupe por canal secundário', () => {
  it('número que só existe em entity_channels resolve a entidade existente (não duplica)', async () => {
    const primario = nextPhone();
    const secundario = nextPhone();
    const created: any = await (await post('/save_person', {
      name: 'Dedupe Canal', phone: primario, channels: [{ kind: 'phone', value: secundario }],
    })).json();
    expect(created.action).toBe('created');

    // upsert pelo número SECUNDÁRIO: precisa achar a mesma entidade
    const again: any = await (await post('/save_person', { name: 'Dedupe Canal', phone: secundario })).json();
    expect(again.action).toBe('updated');
    expect(again.id).toBe(created.id);

    const n = await E.DB.prepare(`SELECT count(*) c FROM entities WHERE name = 'Dedupe Canal'`).first();
    expect(n.c).toBe(1);
  });

  it('variante de 9º dígito no canal secundário também deduplica', async () => {
    const semNove = `5541${String(30000000 + phoneSeq++).padStart(8, '0')}`; // 12 dígitos
    const comNove = `${semNove.slice(0, 4)}9${semNove.slice(4)}`;
    const created: any = await (await post('/save_person', {
      name: 'Dedupe Nove Canal', phone: nextPhone(), channels: [{ kind: 'phone', value: semNove }],
    })).json();

    const again: any = await (await post('/save_person', { name: 'Dedupe Nove Canal', phone: comNove })).json();
    expect(again.action).toBe('updated');
    expect(again.id).toBe(created.id);
  });
});

describe('whatsapp sync — telefone canônico e match por canal', () => {
  it('createMember grava telefone NORMALIZADO (dígitos, forma canônica) na coluna e no canal', async () => {
    const digits = `5548${String(910000000 + phoneSeq++).padStart(9, '0')}`;
    const cru = `+${digits.slice(0, 2)} (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
    await E.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify(['g-phone@g.us']));
    await E.CACHE.put(WAGROUPS_KV.createMembers, '1');

    const r = await importWaGroups(E, [{
      chat_id: 'g-phone@g.us', name: 'Grupo Fone Canonico',
      participants: [{ phone: cru, name: 'Membro Cru' }],
    } as any]);
    expect(r.members_created).toBe(1);

    const row = await E.DB.prepare(`SELECT phone FROM entities WHERE name = 'Membro Cru'`).first();
    expect(row.phone).toBe(digits);
    const ch = await E.DB.prepare(
      `SELECT ch.value FROM entity_channels ch JOIN entities e ON e.id = ch.entity_id WHERE e.name = 'Membro Cru'`
    ).first();
    expect(ch.value).toBe(digits);

    await E.CACHE.delete(WAGROUPS_KV.allowlist);
    await E.CACHE.delete(WAGROUPS_KV.createMembers);
  });

  it('participante cujo número só existe como canal secundário casa com a entidade (não recria)', async () => {
    const primario = nextPhone();
    const secundario = nextPhone();
    const created: any = await (await post('/save_person', {
      name: 'Membro Via Canal', phone: primario, channels: [{ kind: 'phone', value: secundario }],
    })).json();

    await E.CACHE.put(WAGROUPS_KV.allowlist, JSON.stringify(['g-canal@g.us']));
    await E.CACHE.put(WAGROUPS_KV.createMembers, '1');
    const r = await importWaGroups(E, [{
      chat_id: 'g-canal@g.us', name: 'Grupo Canal',
      participants: [{ phone: secundario, name: 'Membro Via Canal' }],
    } as any]);
    expect(r.members_created).toBe(0); // casou com a entidade existente via canal

    const n = await E.DB.prepare(`SELECT count(*) c FROM entities WHERE name = 'Membro Via Canal'`).first();
    expect(n.c).toBe(1);
    // e o vínculo member_of aponta pra entidade original
    const link = await E.DB.prepare(
      `SELECT count(*) c FROM connections WHERE type = 'member_of' AND (a_id = ? OR b_id = ?)`
    ).bind(created.id, created.id).first();
    expect(link.c).toBe(1);

    await E.CACHE.delete(WAGROUPS_KV.allowlist);
    await E.CACHE.delete(WAGROUPS_KV.createMembers);
  });
});
