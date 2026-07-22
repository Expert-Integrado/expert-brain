import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/contacts/index';
import {
  runSnapshot,
  runSnapshotRecorded,
  SNAPSHOT_CRON,
  LAST_BACKUP_KEY,
  BACKUP_PREFIX,
  RETAIN_SNAPSHOTS,
} from '../../src/contacts/backup/snapshot';
import { buildZip, crc32 } from '../../src/contacts/backup/zip';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';
import type { Env } from '../../src/contacts/env';

// Backup/export (spec 50-console-v2/67): snapshot D1→R2 em JSONL + manifest,
// retenção de 8, dispatch do cron por controller.cron e auth de sessão nas
// rotas do Console (CONTACTS_PROXY_TOKEN e caminhos públicos NÃO acessam nada
// de backup).

const tEnv = env as unknown as Env;
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const uuid = () => crypto.randomUUID();

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(tEnv), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

// Storage é COMPARTILHADO entre arquivos (isolatedStorage: false) — cada bloco
// limpa o namespace de backup antes de mexer nele.
async function purgeBackups(): Promise<void> {
  for (;;) {
    const l = await env.MEDIA.list({ prefix: BACKUP_PREFIX, limit: 1000 });
    const keys = (l.objects ?? []).map((o) => o.key);
    if (!keys.length) break;
    await env.MEDIA.delete(keys);
    if (!l.truncated) break;
  }
  await env.CACHE.delete(LAST_BACKUP_KEY);
}

async function listBackupKeys(): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const l = await env.MEDIA.list({ prefix: BACKUP_PREFIX, cursor });
    for (const o of l.objects ?? []) out.push(o.key);
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return out.sort();
}

async function countRows(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>();
  return r?.n ?? 0;
}

// Fixture mínima cobrindo as 4 tabelas de dados (ids/phones únicos por run —
// o D1 é compartilhado com as outras suítes).
async function insertFixture() {
  const a = uuid();
  const b = uuid();
  const c = uuid();
  const phone = `55119${Math.floor(10000000 + Math.random() * 89999999)}`;
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, phone, avatar_r2_key) VALUES (?, 'person', 'Backup Fixture A', ?, 'sha256/aaaa.jpg')`
  ).bind(a, phone).run();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name) VALUES (?, 'person', 'Backup Fixture B')`
  ).bind(b).run();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name) VALUES (?, 'company', 'Backup Fixture Corp')`
  ).bind(c).run();
  const conn = uuid();
  await env.DB.prepare(
    `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, 'colleague', 0.5, 'fixture de backup com why longo o suficiente')`
  ).bind(conn, a, b).run();
  const ev = uuid();
  await env.DB.prepare(
    `INSERT INTO events (id, entity_id, kind, context, source) VALUES (?, ?, 'note', 'evento fixture do backup', 'manual')`
  ).bind(ev, a).run();
  const med = uuid();
  await env.DB.prepare(
    `INSERT INTO media (id, entity_id, kind, r2_key, content_hash, mime_type, byte_size) VALUES (?, ?, 'avatar', 'sha256/bbbb.jpg', 'bbbb', 'image/jpeg', 10)`
  ).bind(med, a).run();
  return { a, b, c, conn, ev, med };
}

// Leitor mínimo de ZIP STORE (só local headers em sequência — o buildZip não
// usa data descriptors, então os tamanhos estão no próprio header).
function readZipEntries(buf: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  let off = 0;
  while (off + 4 <= buf.length && view.getUint32(off, true) === 0x04034b50) {
    const compSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = new TextDecoder().decode(buf.subarray(off + 30, off + 30 + nameLen));
    const dataStart = off + 30 + nameLen + extraLen;
    entries.push({ name, data: buf.subarray(dataStart, dataStart + compSize) });
    off = dataStart + compSize;
  }
  return entries;
}

const td = new TextDecoder();
const jsonlLines = (data: Uint8Array): string[] =>
  td.decode(data).split('\n').filter((l) => l.trim().length);

describe('runSnapshot — round-trip com fixture', () => {
  beforeEach(purgeBackups);

  it('gera 1 JSONL por tabela + manifest com contagens batendo', async () => {
    const fx = await insertFixture();
    const result = await runSnapshot(tEnv);

    expect(result.ok).toBe(true);
    expect(result.prefix).toBe(`${BACKUP_PREFIX}${result.date}/`);
    // manifest é o ÚLTIMO arquivo gravado (marcador de snapshot completo)
    expect(result.files[result.files.length - 1]).toBe(`${result.prefix}manifest.json`);

    // todas as tabelas de dados presentes, com contagem = banco vivo
    for (const table of ['entities', 'connections', 'events', 'media']) {
      expect(result.tables[table]).toBe(await countRows(table));
    }

    // manifest no R2 bate com o resultado
    const manifestObj = await env.MEDIA.get(`${result.prefix}manifest.json`);
    expect(manifestObj).not.toBeNull();
    const manifest = JSON.parse(await manifestObj!.text());
    expect(manifest.service).toBe('expert-contacts');
    expect(manifest.tables).toEqual(result.tables);
    expect(manifest.vectorize.included).toBe(false);
    expect(manifest.r2_media.copied).toBe(false);
    // keys de mídia referenciadas (media.r2_key + entities.avatar_r2_key)
    expect(manifest.r2_media.keys).toContain('sha256/aaaa.jpg');
    expect(manifest.r2_media.keys).toContain('sha256/bbbb.jpg');
    expect('schema_version' in manifest).toBe(true);

    // JSONL: linhas = contagem e a fixture está lá, campo a campo
    const entObj = await env.MEDIA.get(`${result.prefix}entities.jsonl`);
    const lines = jsonlLines(new Uint8Array(await entObj!.arrayBuffer()));
    expect(lines.length).toBe(result.tables.entities);
    const rowA = lines.map((l) => JSON.parse(l)).find((r) => r.id === fx.a);
    expect(rowA).toBeDefined();
    expect(rowA.name).toBe('Backup Fixture A');
    expect(rowA.kind).toBe('person');
    expect(rowA.avatar_r2_key).toBe('sha256/aaaa.jpg');

    const connObj = await env.MEDIA.get(`${result.prefix}connections.jsonl`);
    const connRows = jsonlLines(new Uint8Array(await connObj!.arrayBuffer())).map((l) => JSON.parse(l));
    expect(connRows.find((r) => r.id === fx.conn)?.a_id).toBe(fx.a);
  });

  it('pagina o dump em lotes de 500 (tabela com 1200+ linhas sai inteira)', async () => {
    const holder = uuid();
    await env.DB.prepare(`INSERT INTO entities (id, kind, name) VALUES (?, 'person', 'Bulk Holder')`)
      .bind(holder).run();
    const stmts = [];
    for (let i = 0; i < 1200; i++) {
      stmts.push(
        env.DB.prepare(`INSERT INTO events (id, entity_id, kind, context) VALUES (?, ?, 'note', ?)`)
          .bind(uuid(), holder, `bulk ${i}`)
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

    const liveEvents = await countRows('events');
    expect(liveEvents).toBeGreaterThanOrEqual(1200);
    const result = await runSnapshot(tEnv);
    expect(result.tables.events).toBe(liveEvents);
    const evObj = await env.MEDIA.get(`${result.prefix}events.jsonl`);
    expect(jsonlLines(new Uint8Array(await evObj!.arrayBuffer())).length).toBe(liveEvents);

    // limpa o volume (storage compartilhado com as outras suítes)
    await env.DB.prepare(`DELETE FROM events WHERE entity_id = ?`).bind(holder).run();
    await env.DB.prepare(`DELETE FROM entities WHERE id = ?`).bind(holder).run();
  });
});

describe('retenção — últimos 8, apaga excedente SÓ após sucesso', () => {
  beforeEach(purgeBackups);

  async function seedFakeSnapshots(n: number): Promise<string[]> {
    const prefixes: string[] = [];
    for (let i = 1; i <= n; i++) {
      const p = `${BACKUP_PREFIX}2020-01-${String(i).padStart(2, '0')}/`;
      await env.MEDIA.put(`${p}manifest.json`, JSON.stringify({ fake: true }));
      await env.MEDIA.put(`${p}entities.jsonl`, '{}\n');
      prefixes.push(p);
    }
    return prefixes;
  }

  it('com 8 snapshots existentes, o novo apaga somente o mais antigo', async () => {
    const seeded = await seedFakeSnapshots(RETAIN_SNAPSHOTS);
    const result = await runSnapshot(tEnv);
    expect(result.deleted_snapshots).toEqual([seeded[0]]);

    const keys = await listBackupKeys();
    // mais antigo sumiu POR COMPLETO (todos os objetos do prefixo)
    expect(keys.some((k) => k.startsWith(seeded[0]))).toBe(false);
    // os outros 7 + o novo continuam
    for (let i = 1; i < seeded.length; i++) {
      expect(keys.some((k) => k.startsWith(seeded[i]))).toBe(true);
    }
    expect(keys.some((k) => k.startsWith(result.prefix))).toBe(true);
    // total de prefixos = RETAIN_SNAPSHOTS
    const prefixes = new Set(keys.map((k) => k.split('/').slice(0, 2).join('/') + '/'));
    expect(prefixes.size).toBe(RETAIN_SNAPSHOTS);
  });

  it('snapshot FALHO não apaga nada (e registra a falha no CACHE)', async () => {
    const seeded = await seedFakeSnapshots(3);
    const before = await listBackupKeys();

    const broken = { ...tEnv, MEDIA: undefined } as unknown as Env;
    const outcome = await runSnapshotRecorded(broken);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('MEDIA');

    // nada foi apagado nem gravado
    expect(await listBackupKeys()).toEqual(before);
    expect(seeded.length).toBe(3);
    // falha registrada em backup:last
    const last = JSON.parse((await env.CACHE.get(LAST_BACKUP_KEY))!);
    expect(last.ok).toBe(false);
  });

  it('sucesso registra o resultado em backup:last', async () => {
    const outcome = await runSnapshotRecorded(tEnv);
    expect(outcome.ok).toBe(true);
    const last = JSON.parse((await env.CACHE.get(LAST_BACKUP_KEY))!);
    expect(last.ok).toBe(true);
    expect(last.prefix).toBe((outcome as any).prefix);
  });
});

describe('cron — dispatch por controller.cron', () => {
  beforeEach(purgeBackups);

  const runScheduled = async (cron: string) => {
    const controller = { cron, scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController;
    const ctx = createExecutionContext();
    await worker.scheduled(controller, tEnv, ctx);
    await waitOnExecutionContext(ctx);
  };

  it(`expressão nova (${SNAPSHOT_CRON}) dispara o snapshot`, async () => {
    await runScheduled(SNAPSHOT_CRON);
    const last = JSON.parse((await env.CACHE.get(LAST_BACKUP_KEY))!);
    expect(last.ok).toBe(true);
    const keys = await listBackupKeys();
    expect(keys.some((k) => k.endsWith('manifest.json'))).toBe(true);
  });

  it('expressão diária existente NÃO dispara snapshot (rotina atual segue intocada)', async () => {
    await runScheduled('0 9 * * *');
    // nada de backup rodou (sem PIPEDRIVE_API_KEY a manutenção retorna cedo,
    // mas o ponto aqui é o dispatch: o caminho de snapshot não é tocado)
    expect(await env.CACHE.get(LAST_BACKUP_KEY)).toBeNull();
    expect(await listBackupKeys()).toEqual([]);
  });
});

describe('auth — rotas de backup exigem SESSÃO (nenhum caminho público novo)', () => {
  beforeEach(purgeBackups);

  it('GET /app/export sem sessão => redirect pro login', async () => {
    const res = await SELF.fetch('https://x/app/export', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/app/login');
  });

  it('POST /app/backup/run sem sessão => redirect pro login', async () => {
    const res = await SELF.fetch('https://x/app/backup/run', { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/app/login');
  });

  it('CONTACTS_PROXY_TOKEN NÃO acessa backup (allowlist do proxy é só graph/meta/entity)', async () => {
    const headers = { authorization: 'Bearer test-proxy-token' };
    const exp = await SELF.fetch('https://x/app/export', { headers, redirect: 'manual' });
    expect(exp.status).toBe(302); // caiu no gate de sessão, não em 200
    const run = await SELF.fetch('https://x/app/backup/run', { method: 'POST', headers, redirect: 'manual' });
    expect(run.status).toBe(302);
  });

  it('OWNER_TOKEN via Bearer também não substitui sessão no Console', async () => {
    const res = await SELF.fetch('https://x/app/export', {
      headers: { authorization: 'Bearer test-owner-token' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('POST /app/backup/run com sessão => roda e devolve JSON do resultado', async () => {
    const res = await SELF.fetch('https://x/app/backup/run', {
      method: 'POST',
      headers: { cookie: await sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tables.entities).toBe(await countRows('entities'));
  });

  it('POST /app/backup/run via <form> (Accept: text/html) => 303 de volta pra config', async () => {
    const res = await SELF.fetch('https://x/app/backup/run', {
      method: 'POST',
      headers: { cookie: await sessionCookie(), accept: 'text/html' },
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/config?backup=ok');
  });
});

describe('export — ZIP válido com o MESMO conteúdo do snapshot', () => {
  beforeEach(purgeBackups);

  it('GET /app/export com sessão devolve ZIP com manifest + JSONL consistentes', async () => {
    await insertFixture();
    const res = await SELF.fetch('https://x/app/export', {
      headers: { cookie: await sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition') || '').toContain('expert-contacts-backup-');

    const buf = new Uint8Array(await res.arrayBuffer());
    // assinatura de local file header
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);

    const entries = readZipEntries(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('entities.jsonl');
    expect(names).toContain('connections.jsonl');
    expect(names).toContain('events.jsonl');
    expect(names).toContain('media.jsonl');

    const manifest = JSON.parse(td.decode(entries.find((e) => e.name === 'manifest.json')!.data));
    // contagens do manifest = banco vivo E = linhas dos JSONL do próprio ZIP
    for (const table of ['entities', 'connections', 'events', 'media']) {
      const lines = jsonlLines(entries.find((e) => e.name === `${table}.jsonl`)!.data);
      expect(manifest.tables[table]).toBe(await countRows(table));
      expect(lines.length).toBe(manifest.tables[table]);
      // cada linha é JSON válido (reimporta limpo)
      for (const l of lines.slice(0, 5)) expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  it('config /app/config mostra a seção Backup com as duas ações', async () => {
    await runSnapshotRecorded(tEnv);
    const res = await SELF.fetch('https://x/app/config', {
      headers: { cookie: await sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Fazer backup agora');
    expect(html).toContain('/app/export');
    expect(html).toContain('Último snapshot');
  });
});

describe('zip — CRC e estrutura', () => {
  it('buildZip STORE round-trip (nome + bytes + CRC)', () => {
    const data = new TextEncoder().encode('{"id":"x"}\n{"id":"y"}\n');
    const zip = buildZip([{ name: 'entities.jsonl', data }]);
    const [entry] = readZipEntries(zip);
    expect(entry.name).toBe('entities.jsonl');
    expect(td.decode(entry.data)).toBe('{"id":"x"}\n{"id":"y"}\n');
    // CRC do header bate com o CRC recalculado do payload
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(14, true)).toBe(crc32(data));
  });
});
