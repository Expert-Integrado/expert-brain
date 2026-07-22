import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../src/contacts/db/migrate';
import { resolveIgEntity, pushIgContact } from '../../src/contacts/instagram/sync';
import { handleIgDossier, handleIgPush } from '../../src/contacts/instagram/routes';

// Conexão AO VIVO Instagram Agent ↔ vault (specs/instagram-contacts-live.md):
// dossiê sob demanda + escrita por intenção. Dados 100% fictícios (repo público):
// Diana Prado, Edu Farias, Fábio Gomes.

const E = env as any;

const SID_D = 'igsid-live-4444';
const SID_E = 'igsid-live-5555';
const SID_F = 'igsid-live-6666';

const seedPerson = async (over: Record<string, unknown> = {}): Promise<string> => {
  const id = crypto.randomUUID();
  await E.DB.prepare(
    `INSERT INTO entities (id, kind, name, phone, category, company, private, source)
     VALUES (?, 'person', ?, ?, ?, ?, ?, 'seed')`
  ).bind(
    id, (over.name as string) ?? 'Diana Prado', (over.phone as string) ?? null,
    (over.category as string) ?? null, (over.company as string) ?? null,
    (over.private as number) ?? 0,
  ).run();
  return id;
};

const dossier = (qs: string) =>
  handleIgDossier(new Request(`https://x/instagram/contacts/dossier?${qs}`), E);

const push = (body: unknown) =>
  handleIgPush(new Request('https://x/instagram/contacts/push', {
    method: 'POST', body: JSON.stringify(body),
  }), E);

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await E.DB.prepare(`DELETE FROM instagram_links WHERE igsid IN (?, ?, ?)`).bind(SID_D, SID_E, SID_F).run();
});

describe('roteamento + auth (worker inteiro)', () => {
  it('sem INSTAGRAM_SYNC_TOKEN as rotas novas existem mas respondem 503 (integração desligada)', async () => {
    const d = await SELF.fetch('https://x/instagram/contacts/dossier?username=alguem');
    expect(d.status).toBe(503);
    const p = await SELF.fetch('https://x/instagram/contacts/push', { method: 'POST', body: '{}' });
    expect(p.status).toBe(503);
  });
});

describe('resolveIgEntity — precedência das chaves', () => {
  it('igsid (vínculo durável) ganha de username; entity_id ganha de todos; phone é último', async () => {
    const viaLink = await seedPerson({ name: 'Diana Prado' });
    const viaChannel = await seedPerson({ name: 'Edu Farias' });
    const viaPhone = await seedPerson({ name: 'Fábio Gomes', phone: '5511933330001' });
    await E.DB.prepare(`INSERT INTO instagram_links (igsid, entity_id, synced_at) VALUES (?, ?, datetime('now'))`)
      .bind(SID_D, viaLink).run();
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'edu.farias', 0)`
    ).bind(crypto.randomUUID(), viaChannel).run();

    // username reciclado: o igsid aponta pra Diana mesmo com o @ do Edu no request
    const r1 = await resolveIgEntity(E, { igsid: SID_D, username: 'edu.farias' });
    expect(r1).toMatchObject({ id: viaLink, matched_via: 'igsid' });
    const r2 = await resolveIgEntity(E, { username: 'edu.farias' });
    expect(r2).toMatchObject({ id: viaChannel, matched_via: 'username' });
    // variantes do 9º dígito são mão-dupla: número SEM o 9 acha o fixture COM o 9
    const r3 = await resolveIgEntity(E, { phone: '551133330001' });
    expect(r3).toMatchObject({ id: viaPhone, matched_via: 'phone' });
    const r4 = await resolveIgEntity(E, { phone: '11933330001' });
    expect(r4).toMatchObject({ id: viaPhone, matched_via: 'phone' });
    const r5 = await resolveIgEntity(E, { entity_id: viaPhone, igsid: SID_D });
    expect(r5).toMatchObject({ id: viaPhone, matched_via: 'entity_id' });
    // entity_id apagado cai pros fallbacks
    const r6 = await resolveIgEntity(E, { entity_id: crypto.randomUUID(), igsid: SID_D });
    expect(r6).toMatchObject({ id: viaLink, matched_via: 'igsid' });
  });
});

describe('GET /instagram/contacts/dossier', () => {
  it('sem chave nenhuma → 400; desconhecido → found:false', async () => {
    expect((await dossier('')).status).toBe(400);
    const r = await (await dossier('username=nao.existe.ninguem')).json() as any;
    expect(r).toMatchObject({ ok: true, found: false });
  });

  it('dossiê completo: entity + channels + connections + timeline (privado filtrado)', async () => {
    const id = await seedPerson({ name: 'Diana Prado', category: 'cliente', company: 'Prado Legal' });
    const amigo = await seedPerson({ name: 'Edu Farias' });
    const oculto = await seedPerson({ name: 'Contato Sigiloso', private: 1 });
    await E.DB.prepare(`INSERT INTO instagram_links (igsid, entity_id, synced_at) VALUES (?, ?, datetime('now'))`)
      .bind(SID_E, id).run();
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'diana.prado', 0)`
    ).bind(crypto.randomUUID(), id).run();
    for (const [other, type] of [[amigo, 'friend_of'], [oculto, 'friend_of']] as const) {
      await E.DB.prepare(
        `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, ?, 1, 'conhecidos de longa data do bairro')`
      ).bind(crypto.randomUUID(), id, other, type).run();
    }
    await E.DB.prepare(
      `INSERT INTO events (id, entity_id, kind, ts, context, source, private) VALUES
       (?, ?, 'note', datetime('now'), 'observação pública', 'manual', 0),
       (?, ?, 'note', datetime('now'), 'observação privada', 'manual', 1)`
    ).bind(crypto.randomUUID(), id, crypto.randomUUID(), id).run();

    const r = await (await dossier(`igsid=${SID_E}`)).json() as any;
    expect(r.found).toBe(true);
    expect(r.matched_via).toBe('igsid');
    expect(r.entity).toMatchObject({ id, name: 'Diana Prado', category: 'cliente', company: 'Prado Legal' });
    expect(r.channels.some((c: any) => c.kind === 'instagram' && c.value === 'diana.prado')).toBe(true);
    // conexão com entidade privada some; a pública fica
    expect(r.connections).toHaveLength(1);
    expect(r.connections[0]).toMatchObject({ type: 'friend_of', other: 'Edu Farias' });
    // evento privado não desce pro canal da conversa
    const contexts = r.recent_events.map((e: any) => e.context);
    expect(contexts).toContain('observação pública');
    expect(contexts).not.toContain('observação privada');
  });

  it('entidade privada devolve só o mínimo (id + nome + flag)', async () => {
    const id = await seedPerson({ name: 'Contato Reservado', private: 1 });
    await E.DB.prepare(`INSERT INTO instagram_links (igsid, entity_id, synced_at) VALUES (?, ?, datetime('now'))`)
      .bind(SID_F, id).run();
    const r = await (await dossier(`igsid=${SID_F}`)).json() as any;
    expect(r).toMatchObject({ ok: true, found: true, private: true, entity: { id, name: 'Contato Reservado' } });
    expect(r.entity.category).toBeUndefined();
    expect(r.recent_events).toBeUndefined();
    expect(r.connections).toBeUndefined();
  });
});

describe('POST /instagram/contacts/push', () => {
  it('category no body é rejeitada; sem identificador é 400; novo sem nome/@ é 400', async () => {
    expect((await push({ username: 'x.y', category: 'lead' })).status).toBe(400);
    expect((await push({ name: 'Sem Identificador' })).status).toBe(400);
    expect((await push({ igsid: SID_D })).status).toBe(400); // novo, mas sem name nem username
  });

  it('perfil novo → person mapeado (nome/@/foto), canal, link, evento note', async () => {
    const res = await push({
      igsid: SID_D, username: '@Novo.Perfil_1', name: 'Novo Perfil', photo_url: 'https://cdn.example/p.jpg',
      profile: { biography: 'bio de teste', followers_count: 1234, is_verified: false },
      context: 'pesquisa durante conversa de teste',
    });
    expect(res.status).toBe(200);
    const r = await res.json() as any;
    expect(r).toMatchObject({ ok: true, action: 'created', category: 'mapeado', name: 'Novo Perfil' });

    const ent = await E.DB.prepare(`SELECT * FROM entities WHERE id = ?`).bind(r.entity_id).first();
    expect(ent).toMatchObject({ name: 'Novo Perfil', category: 'mapeado', source: 'instagram', private: 0 });
    expect(JSON.parse(ent.attributes)).toEqual({ ig_photo_url: 'https://cdn.example/p.jpg' });
    const link = await E.DB.prepare(`SELECT entity_id FROM instagram_links WHERE igsid = ?`).bind(SID_D).first();
    expect(link?.entity_id).toBe(r.entity_id);
    const ch = await E.DB.prepare(
      `SELECT value FROM entity_channels WHERE entity_id = ? AND kind = 'instagram'`
    ).bind(r.entity_id).first();
    expect(ch?.value).toBe('novo.perfil_1');
    const ev = await E.DB.prepare(
      `SELECT kind, source, context FROM events WHERE entity_id = ? ORDER BY ts DESC LIMIT 1`
    ).bind(r.entity_id).first();
    expect(ev).toMatchObject({ kind: 'note', source: 'instagram' });
    expect(ev.context).toContain('bio de teste');
    expect(ev.context).toContain('1234 seguidores');
    expect(ev.context).toContain('pesquisa durante conversa de teste');
  });

  it('existente → enriquece ADITIVO: name/category intactos, link+canal novos, phone só se vazio', async () => {
    const id = await seedPerson({ name: 'Diana Prado', category: 'cliente' });
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'diana.prado.push', 0)`
    ).bind(crypto.randomUUID(), id).run();

    const r = await (await push({
      igsid: SID_E, username: 'diana.prado.push', name: 'nome scrapeado diferente',
      phone: '11944440002', profile: { followers_count: 9 }, context: 'enriquecimento',
    })).json() as any;
    expect(r).toMatchObject({ ok: true, action: 'enriched', entity_id: id, category: 'cliente', matched_via: 'username' });

    const ent = await E.DB.prepare(`SELECT name, category, phone FROM entities WHERE id = ?`).bind(id).first();
    expect(ent.name).toBe('Diana Prado');       // nome curado intocado
    expect(ent.category).toBe('cliente');       // categoria NUNCA muda via push
    expect(ent.phone).toBe('5511944440002');    // vazio → preenchido, forma canônica com 55
    const link = await E.DB.prepare(`SELECT entity_id FROM instagram_links WHERE igsid = ?`).bind(SID_E).first();
    expect(link?.entity_id).toBe(id);           // igsid vinculado pra próxima vez
    const ev = await E.DB.prepare(
      `SELECT context FROM events WHERE entity_id = ? AND kind = 'note' AND source = 'instagram'`
    ).bind(id).first();
    expect(ev?.context).toContain('enriquecimento');
  });

  it('phone de OUTRA entidade → phone_conflict, sem sobrescrever ninguém', async () => {
    const dona = await seedPerson({ name: 'Dona do Número', phone: '5511955550003' });
    const alvo = await seedPerson({ name: 'Edu Farias' });
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'edu.farias2', 0)`
    ).bind(crypto.randomUUID(), alvo).run();

    const r = await (await push({ username: 'edu.farias2', phone: '11955550003' })).json() as any;
    expect(r).toMatchObject({ ok: true, action: 'enriched', entity_id: alvo, phone_conflict: true });
    const ent = await E.DB.prepare(`SELECT phone FROM entities WHERE id = ?`).bind(alvo).first();
    expect(ent.phone).toBeNull();
    const other = await E.DB.prepare(`SELECT phone FROM entities WHERE id = ?`).bind(dona).first();
    expect(other.phone).toBe('5511955550003');
  });

  it('GUARD: igsid já vinculado a OUTRA entidade → 409 igsid_link_conflict, nada gravado', async () => {
    const certa = await seedPerson({ name: 'Pessoa Certa' });
    const errada = await seedPerson({ name: 'Pessoa Errada (vault_contact_id stale)' });
    await E.DB.prepare(`INSERT INTO instagram_links (igsid, entity_id, synced_at) VALUES (?, ?, datetime('now'))`)
      .bind(SID_F, certa).run();

    const res = await push({ entity_id: errada, igsid: SID_F, username: 'handle.reciclado.x', context: 'nao deveria gravar' });
    expect(res.status).toBe(409);
    const r = await res.json() as any;
    expect(r).toMatchObject({ ok: false, error: 'igsid_link_conflict', entity_id: errada, linked_entity_id: certa });
    // vínculo durável intacto, nenhuma escrita colateral na entidade errada
    const link = await E.DB.prepare(`SELECT entity_id FROM instagram_links WHERE igsid = ?`).bind(SID_F).first();
    expect(link?.entity_id).toBe(certa);
    const ch = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM entity_channels WHERE entity_id = ? AND kind = 'instagram'`
    ).bind(errada).first();
    expect(ch.n).toBe(0);
    const ev = await E.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE entity_id = ?`).bind(errada).first();
    expect(ev.n).toBe(0);
  });

  it('entidade PRIVADA: response omite category e a nota nasce private', async () => {
    const id = await seedPerson({ name: 'Reservada Silva', category: 'vip', private: 1 });
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'reservada.priv', 0)`
    ).bind(crypto.randomUUID(), id).run();

    const r = await (await push({ username: 'reservada.priv', context: 'pesquisa privada' })).json() as any;
    expect(r).toMatchObject({ ok: true, action: 'enriched', entity_id: id, private: true });
    expect(r.category).toBeUndefined();
    const ev = await E.DB.prepare(
      `SELECT private FROM events WHERE entity_id = ? AND kind = 'note' ORDER BY ts DESC LIMIT 1`
    ).bind(id).first();
    expect(ev.private).toBe(1);
  });

  it('phone grava na forma canônica com DDI 55; conflito detecta dono via CANAL', async () => {
    // canônica: input sem 55 vira 55...
    const a = await seedPerson({ name: 'Canonica Teste' });
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'canonica.t', 0)`
    ).bind(crypto.randomUUID(), a).run();
    await push({ username: 'canonica.t', phone: '11966660004' });
    const ea = await E.DB.prepare(`SELECT phone FROM entities WHERE id = ?`).bind(a).first();
    expect(ea.phone).toBe('5511966660004');

    // conflito via canal: dona tem o número SÓ em entity_channels
    const dona = await seedPerson({ name: 'Dona Canal' });
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'phone', '5511977770005', 1)`
    ).bind(crypto.randomUUID(), dona).run();
    const alvo = await seedPerson({ name: 'Alvo Canal' });
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'alvo.canal', 0)`
    ).bind(crypto.randomUUID(), alvo).run();
    const r = await (await push({ username: 'alvo.canal', phone: '11977770005' })).json() as any;
    expect(r).toMatchObject({ ok: true, entity_id: alvo, phone_conflict: true });
    const et = await E.DB.prepare(`SELECT phone FROM entities WHERE id = ?`).bind(alvo).first();
    expect(et.phone).toBeNull();
  });

  it('body não-objeto → 400 (não 500); entity_id sozinho é identificador válido', async () => {
    const raw = (b: string) => handleIgPush(new Request('https://x/instagram/contacts/push', { method: 'POST', body: b }), E);
    expect((await raw('null')).status).toBe(400);
    expect((await raw('"texto"')).status).toBe(400);
    expect((await raw('[1,2]')).status).toBe(400);

    const id = await seedPerson({ name: 'So Entity Id' });
    const r = await (await push({ entity_id: id, context: 'push por entity_id puro' })).json() as any;
    expect(r).toMatchObject({ ok: true, action: 'enriched', entity_id: id, matched_via: 'entity_id' });
  });

  it('personsOnly: company com canal @ não recebe enrich de pessoa', async () => {
    const compId = crypto.randomUUID();
    await E.DB.prepare(
      `INSERT INTO entities (id, kind, name, source) VALUES (?, 'company', 'Empresa Fake LTDA', 'seed')`
    ).bind(compId).run();
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'empresa.fake', 0)`
    ).bind(crypto.randomUUID(), compId).run();

    const r = await (await push({ username: 'empresa.fake', name: 'Empresa Fake' })).json() as any;
    // não casa a company → cria person mapeado nova
    expect(r).toMatchObject({ ok: true, action: 'created', category: 'mapeado' });
    expect(r.entity_id).not.toBe(compId);
    // dossiê (read-only) continua achando a company pelo @ (sem personsOnly)
    const d = await (await dossier('username=empresa.fake')).json() as any;
    expect(d.found).toBe(true);
  });

  it('push repetido em janela curta não duplica o evento (dedupe do recordEvent)', async () => {
    const id = await seedPerson({ name: 'Fábio Gomes' });
    await E.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary) VALUES (?, ?, 'instagram', 'fabio.gomes', 0)`
    ).bind(crypto.randomUUID(), id).run();
    const body = { username: 'fabio.gomes', context: 'retry de rede idempotente' };
    await push(body);
    await push(body);
    const n = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE entity_id = ? AND kind = 'note' AND context LIKE '%retry de rede idempotente%'`
    ).bind(id).first();
    expect(n.n).toBe(1);
  });
});
