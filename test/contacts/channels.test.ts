import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';
import {
  normalizeChannel,
  setPrimaryChannel,
  getChannels,
  MAX_CHANNEL_VALUE,
} from '../../src/contacts/channels';

// Spec 50-console-v2/55 — cartela completa de contato: múltiplos e-mails, redes
// sociais, link de CRM e ManyChat. Cobre normalização/validação por kind, espelho
// primário↔coluna, lookup por canal secundário, upsert idempotente e backfill.

const OWNER = 'test-owner-token';
const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const authHeaders = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' };

const post = (path: string, body: unknown) =>
  SELF.fetch(`https://x${path}`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
const get = (path: string) =>
  SELF.fetch(`https://x${path}`, { headers: { authorization: `Bearer ${OWNER}` } });

// telefones únicos por teste (UNIQUE(phone) entre casos).
let phoneSeq = 0;
const nextPhone = () => `5511${String(970000000 + phoneSeq++).padStart(9, '0')}`;

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

// ───────────────────────── normalização / validação por kind ─────────────────────────

describe('normalizeChannel — normalização e validação por kind (spec 55 §3)', () => {
  it('email: trim+lowercase e href mailto', () => {
    const r = normalizeChannel({ kind: 'email', value: '  Foo@Bar.COM  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channel.value).toBe('foo@bar.com');
      expect(r.channel.href).toBe('mailto:foo@bar.com');
    }
  });

  it('email sem @ → erro', () => {
    const r = normalizeChannel({ kind: 'email', value: 'notanemail' });
    expect(r.ok).toBe(false);
  });

  it('phone: só dígitos (E.164 sem +) e href wa.me', () => {
    const r = normalizeChannel({ kind: 'phone', value: '+55 (11) 98765-4321' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channel.value).toBe('5511987654321');
      expect(r.channel.href).toBe('https://wa.me/5511987654321');
    }
  });

  it('phone curto (<8 dígitos) → erro; longo (>15) → erro', () => {
    expect(normalizeChannel({ kind: 'phone', value: '123' }).ok).toBe(false);
    expect(normalizeChannel({ kind: 'phone', value: '1'.repeat(16) }).ok).toBe(false);
  });

  it('instagram: @Fulano e URL completa normalizam pro MESMO handle', () => {
    const a = normalizeChannel({ kind: 'instagram', value: '@Fulano' });
    const b = normalizeChannel({ kind: 'instagram', value: 'https://instagram.com/Fulano' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.channel.value).toBe('fulano');
      expect(b.channel.value).toBe('fulano');
      expect(a.channel.href).toBe('https://instagram.com/fulano');
    }
  });

  it('linkedin: URL preservada; handle vira URL /in/', () => {
    const u = normalizeChannel({ kind: 'linkedin', value: 'https://www.linkedin.com/in/jose' });
    const h = normalizeChannel({ kind: 'linkedin', value: 'jose-silva' });
    expect(u.ok && h.ok).toBe(true);
    if (u.ok) expect(u.channel.href).toBe('https://www.linkedin.com/in/jose');
    if (h.ok) expect(h.channel.href).toBe('https://www.linkedin.com/in/jose-silva');
  });

  it('crm: exige URL http(s); sem protocolo → erro', () => {
    const ok = normalizeChannel({ kind: 'crm', value: 'https://crm.example.com/deal/1' });
    const bad = normalizeChannel({ kind: 'crm', value: 'crm.example.com/deal/1' });
    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    if (ok.ok) expect(ok.channel.href).toBe('https://crm.example.com/deal/1');
  });

  it('manychat: ID livre sem href; URL https com href; http → erro', () => {
    const id = normalizeChannel({ kind: 'manychat', value: 'psid_12345' });
    const url = normalizeChannel({ kind: 'manychat', value: 'https://manychat.com/fb/x' });
    const http = normalizeChannel({ kind: 'manychat', value: 'http://manychat.com/x' });
    expect(id.ok).toBe(true);
    if (id.ok) expect(id.channel.href).toBeNull();
    expect(url.ok).toBe(true);
    if (url.ok) expect(url.channel.href).toBe('https://manychat.com/fb/x');
    expect(http.ok).toBe(false);
  });

  it('site: domínio nu ganha https://; href pronto', () => {
    const r = normalizeChannel({ kind: 'site', value: 'acme.com' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channel.value).toBe('https://acme.com');
      expect(r.channel.href).toBe('https://acme.com');
    }
  });

  it('other: aceita texto, sem href', () => {
    const r = normalizeChannel({ kind: 'other', value: 'algum identificador' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.channel.href).toBeNull();
  });

  it('kind inválido → erro', () => {
    expect(normalizeChannel({ kind: 'telepatia', value: 'x' }).ok).toBe(false);
  });

  it('label > 40 chars → erro; value > 200 chars → erro', () => {
    expect(normalizeChannel({ kind: 'other', value: 'x', label: 'l'.repeat(41) }).ok).toBe(false);
    expect(normalizeChannel({ kind: 'other', value: 'v'.repeat(MAX_CHANNEL_VALUE + 1) }).ok).toBe(false);
  });
});

// ───────────────────────── write path REST + atalhos MCP ─────────────────────────

describe('save_person — atalhos de canais (spec 55 §4)', () => {
  it('emails/instagram/linkedin/crm_url/manychat_id criam os canais', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', {
      name: 'Cartela Cheia',
      phone,
      emails: ['a@ex.com', 'b@ex.com'],
      instagram: '@fulano',
      linkedin: 'https://www.linkedin.com/in/fulano',
      crm_url: 'https://crm.example.com/person/9',
      manychat_id: 'psid_999',
    })).json();
    expect(r.ok).toBe(true);

    const detail: any = await (await get(`/entities/${r.id}`)).json();
    const byKind = (k: string) => detail.channels.filter((c: any) => c.kind === k);
    expect(byKind('email').map((c: any) => c.value).sort()).toEqual(['a@ex.com', 'b@ex.com']);
    expect(byKind('instagram')[0].value).toBe('fulano');
    expect(byKind('instagram')[0].href).toBe('https://instagram.com/fulano');
    expect(byKind('linkedin')).toHaveLength(1);
    expect(byKind('crm')[0].href).toBe('https://crm.example.com/person/9');
    expect(byKind('manychat')[0].value).toBe('psid_999');
    // phone legado virou canal primário espelhando a coluna
    expect(byKind('phone')[0].value).toBe(phone);
    expect(byKind('phone')[0].is_primary).toBe(true);
  });

  it('chamada antiga (só email/phone) segue idêntica + gera canais primários', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', { name: 'Legado', phone, email: 'legado@ex.com' })).json();
    expect(r.action).toBe('created');
    const detail: any = await (await get(`/entities/${r.id}`)).json();
    // colunas intactas
    expect(detail.entity.email).toBe('legado@ex.com');
    expect(detail.entity.phone).toBe(phone);
    // espelho: canal primário de cada kind
    const email = detail.channels.find((c: any) => c.kind === 'email');
    expect(email.value).toBe('legado@ex.com');
    expect(email.is_primary).toBe(true);
  });
});

describe('múltiplos e-mails + troca de primário (spec 55 AC)', () => {
  it('3 e-mails aparecem; trocar o primário atualiza entities.email', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', {
      name: 'Tres Emails', phone,
      channels: [
        { kind: 'email', value: 'um@ex.com' },
        { kind: 'email', value: 'dois@ex.com' },
        { kind: 'email', value: 'tres@ex.com' },
      ],
    })).json();
    const id = r.id;

    let detail: any = await (await get(`/entities/${id}`)).json();
    const emails = detail.channels.filter((c: any) => c.kind === 'email');
    expect(emails).toHaveLength(3);
    for (const e of emails) expect(e.href).toBe(`mailto:${e.value}`);
    // primeiro (position 0) vira primário → espelha a coluna
    expect(detail.entity.email).toBe('um@ex.com');

    // troca o primário pro 'tres@ex.com' via flag primary no save
    await post('/save_person', { id, name: 'Tres Emails', channels: [{ kind: 'email', value: 'tres@ex.com', primary: true }] });
    detail = await (await get(`/entities/${id}`)).json();
    expect(detail.entity.email).toBe('tres@ex.com');
    const primary = detail.channels.find((c: any) => c.kind === 'email' && c.is_primary);
    expect(primary.value).toBe('tres@ex.com');
    // os 3 continuam existindo (nada perdido)
    expect(detail.channels.filter((c: any) => c.kind === 'email')).toHaveLength(3);
  });
});

describe('get_contact_by_phone — telefone SECUNDÁRIO via canal (spec 55 AC)', () => {
  it('resolve por telefone secundário, inclusive variante de 9º dígito', async () => {
    const primary = nextPhone();
    const secondary = '5511987650000'; // com 9
    const r: any = await (await post('/save_person', {
      name: 'Dois Fones', phone: primary,
      channels: [{ kind: 'phone', value: secondary }],
    })).json();
    const id = r.id;

    // coluna só tem o primário; busca pelo secundário SEM o 9 (variante) resolve via canal
    const res: any = await (await get('/get_contact_by_phone?phone=551187650000')).json();
    expect(res.count).toBeGreaterThan(0);
    expect(res.match.id).toBe(id);
    expect(res.matched_via).toBe('channel');
  });
});

describe('validação: valor inválido → erro, nada persiste (spec 55 AC)', () => {
  it('email sem @ no channels → 400 e entidade NÃO é criada', async () => {
    const name = `Invalido ${crypto.randomUUID()}`;
    const res = await post('/save_person', { name, channels: [{ kind: 'email', value: 'lixo' }] });
    expect(res.status).toBe(400);
    const cnt = await env.DB.prepare('SELECT COUNT(*) c FROM entities WHERE name = ?').bind(name).first<{ c: number }>();
    expect(cnt?.c).toBe(0);
  });

  it('crm sem http(s) → 400', async () => {
    const res = await post('/save_person', { name: `Crm ${crypto.randomUUID()}`, crm_url: 'crm.example.com/deal' });
    expect(res.status).toBe(400);
  });
});

describe('compat: attributes intocado + save parcial não apaga canais (spec 55 AC)', () => {
  it('attributes JSON preservado junto com canais', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', {
      name: 'Com Attrs', phone,
      attributes: { foo: 'bar', n: 1 },
      emails: ['x@ex.com'],
    })).json();
    const detail: any = await (await get(`/entities/${r.id}`)).json();
    expect(JSON.parse(detail.entity.attributes)).toEqual({ foo: 'bar', n: 1 });
    expect(detail.channels.some((c: any) => c.value === 'x@ex.com')).toBe(true);
  });

  it('save parcial (só nome) NÃO remove canais existentes', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', {
      name: 'Parcial', phone,
      channels: [{ kind: 'email', value: 'p1@ex.com' }, { kind: 'instagram', value: '@parcial' }],
    })).json();
    const id = r.id;
    const before: any = await (await get(`/entities/${id}`)).json();
    const nBefore = before.channels.length;

    await post('/save_person', { id, name: 'Parcial Renomeado' });
    const after: any = await (await get(`/entities/${id}`)).json();
    expect(after.entity.name).toBe('Parcial Renomeado');
    expect(after.channels.length).toBe(nBefore);
  });

  it('channels_remove remove só o pedido', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', {
      name: 'Remove Um', phone,
      channels: [{ kind: 'instagram', value: '@a' }, { kind: 'instagram', value: '@b' }],
    })).json();
    const id = r.id;
    let detail: any = await (await get(`/entities/${id}`)).json();
    const igA = detail.channels.find((c: any) => c.kind === 'instagram' && c.value === 'a');
    await post('/save_person', { id, name: 'Remove Um', channels_remove: [igA.id] });
    detail = await (await get(`/entities/${id}`)).json();
    const igs = detail.channels.filter((c: any) => c.kind === 'instagram');
    expect(igs).toHaveLength(1);
    expect(igs[0].value).toBe('b');
  });
});

// ───────────────────────── espelho primário↔coluna (invariante) ─────────────────────────

describe('setPrimaryChannel — invariante coluna == canal primário (spec 55 §2)', () => {
  it('promover email atualiza entities.email na MESMA operação', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', {
      name: 'Espelho', phone,
      channels: [{ kind: 'email', value: 'e1@ex.com' }, { kind: 'email', value: 'e2@ex.com' }],
    })).json();
    const id = r.id;
    const chans = await getChannels(env, id);
    const e2 = chans.find((c) => c.kind === 'email' && c.value === 'e2@ex.com')!;
    const sp = await setPrimaryChannel(env, id, e2.id);
    expect(sp.ok).toBe(true);
    const row = await env.DB.prepare('SELECT email FROM entities WHERE id = ?').bind(id).first<{ email: string }>();
    expect(row?.email).toBe('e2@ex.com');
  });

  it('promover telefone que já é de OUTRA entidade → falha (dedupe/merge)', async () => {
    const pA = nextPhone();
    const rA: any = await (await post('/save_person', { name: 'Entidade A', phone: pA })).json();

    // entidade B com um canal de telefone = telefone de A (secundário, is_primary=0)
    const bId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', 'Entidade B', 'seed')`).bind(bId).run();
    const chId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entity_channels (id, entity_id, kind, value, is_primary, position) VALUES (?, ?, 'phone', ?, 0, 0)`
    ).bind(chId, bId, pA).run();

    const sp = await setPrimaryChannel(env, bId, chId);
    expect(sp.ok).toBe(false);
    // B.phone continua null (não sobrescreveu, sem violar UNIQUE)
    const rowB = await env.DB.prepare('SELECT phone FROM entities WHERE id = ?').bind(bId).first<{ phone: string | null }>();
    expect(rowB?.phone).toBeNull();
    // A intacta
    const rowA = await env.DB.prepare('SELECT phone FROM entities WHERE id = ?').bind(rA.id).first<{ phone: string }>();
    expect(rowA?.phone).toBe(pA);
  });
});

// ───────────────────────── Console: CRUD por sessão ─────────────────────────

describe('POST /app/entity/channel_delete + set_primary_channel (sessão)', () => {
  it('remove canal e promove o próximo primário', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', {
      name: 'Sess Canais', phone,
      channels: [{ kind: 'email', value: 'sa@ex.com' }, { kind: 'email', value: 'sb@ex.com' }],
    })).json();
    const id = r.id;
    const cookie = await sessionCookie();

    let detail: any = await (await get(`/entities/${id}`)).json();
    const primaryEmail = detail.channels.find((c: any) => c.kind === 'email' && c.is_primary);

    // remove o e-mail primário → o outro é promovido e espelha a coluna
    const del = await SELF.fetch('https://x/app/entity/channel_delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: primaryEmail.id }),
      redirect: 'manual',
    });
    expect(del.status).toBe(200);

    detail = await (await get(`/entities/${id}`)).json();
    const emails = detail.channels.filter((c: any) => c.kind === 'email');
    expect(emails).toHaveLength(1);
    expect(emails[0].is_primary).toBe(true);
    expect(detail.entity.email).toBe(emails[0].value);
  });

  it('channel_delete sem sessão → 302 (não aplica)', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', { name: 'Sem Sessao', phone, emails: ['z@ex.com'] })).json();
    const detail: any = await (await get(`/entities/${r.id}`)).json();
    const ch = detail.channels.find((c: any) => c.kind === 'email');
    const del = await SELF.fetch('https://x/app/entity/channel_delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ch.id }),
      redirect: 'manual',
    });
    expect(del.status).toBe(302);
  });

  it('/app/entity/update com channels[] adiciona canal (sessão)', async () => {
    const phone = nextPhone();
    const r: any = await (await post('/save_person', { name: 'Upd Canal', phone })).json();
    const id = r.id;
    const cookie = await sessionCookie();
    const res = await SELF.fetch('https://x/app/entity/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id, channels: [{ kind: 'linkedin', value: 'https://www.linkedin.com/in/upd' }] }),
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const detail: any = await (await get(`/entities/${id}`)).json();
    expect(detail.channels.some((c: any) => c.kind === 'linkedin')).toBe(true);
  });
});

// ───────────────────────── backfill da migration 0006 ─────────────────────────

describe('backfill 0006 — canais primários das colunas existentes (spec 55 AC)', () => {
  it('email/phone/website preexistentes viram canais primários; contagens batem', async () => {
    // seed direto (sem canais) simulando dados pré-migration
    const pid = crypto.randomUUID();
    const cid = crypto.randomUUID();
    const ph = nextPhone();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, phone, email, source) VALUES (?, 'person', 'Backfill Pessoa', ?, ?, 'seed')`
    ).bind(pid, ph, 'bf@ex.com').run();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, website, email, source) VALUES (?, 'company', 'Backfill Empresa', ?, ?, 'seed')`
    ).bind(cid, 'https://bf.example.com', 'contato@bf.com').run();

    // roda os 3 INSERT OR IGNORE do backfill (idempotentes) diretamente
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
         SELECT lower(hex(randomblob(16))), id, 'email', email, 1, 0
           FROM entities WHERE id IN (?, ?) AND email IS NOT NULL AND trim(email) != ''`
    ).bind(pid, cid).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
         SELECT lower(hex(randomblob(16))), id, 'phone', phone, 1, 0
           FROM entities WHERE id IN (?, ?) AND phone IS NOT NULL AND trim(phone) != ''`
    ).bind(pid, cid).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
         SELECT lower(hex(randomblob(16))), id, 'site', website, 1, 0
           FROM entities WHERE id IN (?, ?) AND kind = 'company' AND website IS NOT NULL AND trim(website) != ''`
    ).bind(pid, cid).run();

    const pch = await getChannels(env, pid);
    expect(pch.find((c) => c.kind === 'email')?.value).toBe('bf@ex.com');
    expect(pch.find((c) => c.kind === 'phone')?.value).toBe(ph);
    expect(pch.every((c) => c.is_primary === 1)).toBe(true);

    const cch = await getChannels(env, cid);
    expect(cch.find((c) => c.kind === 'site')?.value).toBe('https://bf.example.com');
    expect(cch.find((c) => c.kind === 'email')?.value).toBe('contato@bf.com');

    // idempotência: rodar de novo não duplica (UNIQUE + INSERT OR IGNORE)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
         SELECT lower(hex(randomblob(16))), id, 'email', email, 1, 0
           FROM entities WHERE id = ? AND email IS NOT NULL`
    ).bind(pid).run();
    const pch2 = await getChannels(env, pid);
    expect(pch2.filter((c) => c.kind === 'email')).toHaveLength(1);
  });
});
