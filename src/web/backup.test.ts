import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';
import { LAST_BACKUP_META_KEY, BACKUP_PREFIX } from '../backup/snapshot.js';
import { unzip } from '../../test/util/mini-unzip.js';

// Endpoints de backup (spec 67): sessão obrigatória nos dois, backup-now grava
// R2 + meta, export entrega ZIP válido e consistente com o próprio manifest.

const E = env as any;
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  (env as any).OWNER_EMAIL = 'owner@example.com';
  (env as any).SESSION_SECRET = SECRET;
  await runMigrations(E);
  // Pelo menos 1 nota garante dump não-vazio (id próprio pra não colidir com
  // outras suítes — storage é compartilhado no singleWorker).
  await E.DB.prepare(
    `INSERT OR REPLACE INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at)
     VALUES ('bkpweb-n1', 'Nota export', 'corpo export', 'tldr export', '["operations"]', 'fact', 1000, 1000)`
  ).run();
});

describe('auth dos endpoints de backup (spec 67)', () => {
  it('GET /app/export sem sessão redireciona pro login', async () => {
    const res = await SELF.fetch('https://x.test/app/export', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login/);
  });

  it('POST /app/config/backup-now sem sessão redireciona pro login', async () => {
    const res = await SELF.fetch('https://x.test/app/config/backup-now', {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login/);
  });
});

describe('POST /app/config/backup-now', () => {
  it('roda o snapshot, grava R2 + last_backup e volta pra seção Backup', async () => {
    const res = await SELF.fetch('https://x.test/app/config/backup-now', {
      method: 'POST',
      headers: { cookie: await authCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/config?saved=backup#backup');

    const metaRow = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(LAST_BACKUP_META_KEY).first();
    const saved = JSON.parse(metaRow.value);
    expect(saved.ok).toBe(true);

    const manifestObj = await E.MEDIA.get(`${saved.prefix}manifest.json`);
    expect(manifestObj).not.toBeNull();
  });
});

describe('GET /app/export', () => {
  it('entrega ZIP válido cujos JSONL batem com o manifest interno', async () => {
    const res = await SELF.fetch('https://x.test/app/export', {
      headers: { cookie: await authCookie() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition') ?? '').toContain('expert-brain-export-');

    const zip = new Uint8Array(await res.arrayBuffer());
    const files = await unzip(zip); // leitor independente: valida CRC e tamanhos
    const dec = new TextDecoder();

    expect(files.has('manifest.json')).toBe(true);
    const manifest = JSON.parse(dec.decode(files.get('manifest.json')!));
    // Bump pra 0022 (spec 82 — mailbox por agente).
    expect(manifest.schema_version).toBe('0022_agent_mailbox');
    expect(Object.keys(manifest.tables)).toContain('notes');

    for (const [table, count] of Object.entries(manifest.tables as Record<string, number>)) {
      const entry = files.get(`${table}.jsonl`);
      expect(entry, `${table}.jsonl presente no ZIP`).toBeTruthy();
      const lines = dec.decode(entry!).split('\n').filter((l) => l.trim() !== '');
      expect(lines.length, `linhas de ${table}.jsonl`).toBe(count);
    }
    // A nota semeada está no export, com conteúdo íntegro.
    const notes = dec.decode(files.get('notes.jsonl')!);
    expect(notes).toContain('bkpweb-n1');
  });
});

describe('/app/config — seção Backup', () => {
  it('renderiza status, botão de backup e botão de export', async () => {
    const res = await SELF.fetch('https://x.test/app/config', {
      headers: { cookie: await authCookie() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="backup"');
    expect(html).toContain('Fazer backup agora');
    expect(html).toContain('Baixar export');
    expect(html).toContain('action="/app/config/backup-now"');
    expect(html).toContain('action="/app/export"');
  });
});
