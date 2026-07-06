// Spec 50-console-v2/70 — "Instruções do dono": meta round-trip, sanitize/cap,
// composição do handshake e auth do POST de sessão.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import {
  sanitizeOwnerInstructions,
  readOwnerInstructions,
  writeOwnerInstructions,
  OWNER_INSTRUCTIONS_MAX_LEN,
} from '../src/db/meta.js';
import { buildServerInstructions } from '../src/mcp/instructions.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

beforeEach(async () => {
  // Estado limpo por teste (storage compartilhado entre arquivos, singleWorker).
  await E.DB.prepare(`DELETE FROM meta WHERE key = 'owner_instructions'`).run();
});

describe('sanitizeOwnerInstructions', () => {
  it('remove caracteres de controle mas preserva TAB, CR e LF', () => {
    const raw = 'linha 1\n\tlinha 2\r\ncom\x00controle\x1b[31m e DEL\x7f no meio';
    const out = sanitizeOwnerInstructions(raw);
    expect(out).toContain('linha 1\n\tlinha 2\r\n');
    expect(out).not.toContain('\x00');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x7f');
    expect(out).toContain('comcontrole');
  });

  it('faz trim e aplica o cap de 4000 chars', () => {
    const raw = '  ' + 'a'.repeat(OWNER_INSTRUCTIONS_MAX_LEN + 500) + '  ';
    const out = sanitizeOwnerInstructions(raw);
    expect(out.length).toBe(OWNER_INSTRUCTIONS_MAX_LEN);
    expect(out.startsWith('a')).toBe(true);
  });

  it('texto só de espaços/controle vira string vazia', () => {
    expect(sanitizeOwnerInstructions('  \x00\x01  ')).toBe('');
  });
});

describe('writeOwnerInstructions / readOwnerInstructions', () => {
  it('round-trip: grava sanitizado e lê de volta', async () => {
    const written = await writeOwnerInstructions(E, '  Sempre responda em pt-BR.\nNunca crie task sem due.  ');
    expect(written).toBe('Sempre responda em pt-BR.\nNunca crie task sem due.');
    expect(await readOwnerInstructions(E)).toBe(written);
  });

  it('texto vazio REMOVE a chave (read volta null)', async () => {
    await writeOwnerInstructions(E, 'algo');
    expect(await readOwnerInstructions(E)).toBe('algo');
    const written = await writeOwnerInstructions(E, '   ');
    expect(written).toBe('');
    expect(await readOwnerInstructions(E)).toBeNull();
  });
});

describe('buildServerInstructions — bloco do dono', () => {
  it('sem ownerInstructions: saída byte a byte idêntica à atual', () => {
    const base = buildServerInstructions(null, { hasMedia: true, hasContacts: true });
    const withNull = buildServerInstructions(null, { hasMedia: true, hasContacts: true, ownerInstructions: null });
    const withEmpty = buildServerInstructions(null, { hasMedia: true, hasContacts: true, ownerInstructions: '   ' });
    expect(withNull).toBe(base);
    expect(withEmpty).toBe(base);
  });

  it('com ownerInstructions: bloco delimitado no FIM do texto', () => {
    const txt = 'Priorize o domínio operations. Responda em pt-BR.';
    const out = buildServerInstructions(null, { ownerInstructions: txt });
    const marker = '--- INSTRUÇÕES DO DONO DESTA INSTÂNCIA (editáveis em /app/config) ---';
    expect(out).toContain(marker);
    expect(out.indexOf(marker)).toBeGreaterThan(out.length - marker.length - txt.length - 10);
    expect(out.endsWith(txt)).toBe(true);
  });
});

describe('POST /app/config/owner-instructions', () => {
  it('com sessão: 302 pra config e persiste na meta', async () => {
    const body = new URLSearchParams({ owner_instructions: 'Regra global: responda em pt-BR.' });
    const res = await SELF.fetch('https://x/app/config/owner-instructions', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('saved=owner');
    expect(await readOwnerInstructions(E)).toBe('Regra global: responda em pt-BR.');
  });

  it('sem sessão: não persiste (redirect/401)', async () => {
    const body = new URLSearchParams({ owner_instructions: 'invasor' });
    const res = await SELF.fetch('https://x/app/config/owner-instructions', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    expect([302, 401]).toContain(res.status);
    expect(await readOwnerInstructions(E)).toBeNull();
  });
});
