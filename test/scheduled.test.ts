import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations } from '../src/db/migrate.js';
import { runScheduled, BACKUP_CRON } from '../src/scheduled.js';
import { LAST_BACKUP_META_KEY } from '../src/backup/snapshot.js';
import { RESURFACE_DIGEST_META_KEY } from '../src/digest/resurface.js';

// Dispatch do scheduled() por controller.cron (spec 67): a expressão nova dispara
// o snapshot; a rotina diária existente (digest de tasks) segue intocada. O
// index.ts delega 1:1 pra runScheduled — aqui forjamos os dois valores de cron.

const E = env as any;

// Contexto forjado: coleta os waitUntil pra podermos aguardar o término.
function fakeCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(waits) };
}

async function lastBackupValue(): Promise<string | null> {
  const row = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(LAST_BACKUP_META_KEY).first();
  return row?.value ?? null;
}

async function resurfaceDigestValue(): Promise<string | null> {
  const row = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).first();
  return row?.value ?? null;
}

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await E.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(LAST_BACKUP_META_KEY).run();
  await E.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).run();
});

describe('runScheduled — dispatch por cron (spec 67)', () => {
  it('a expressão do backup bate com a do wrangler.example.toml', () => {
    // Se mudar lá ([triggers].crons), TEM que mudar aqui — senão o snapshot
    // semanal silenciosamente cai no fluxo do digest.
    expect(BACKUP_CRON).toBe('0 5 * * 1');
  });

  it('cron do backup ("0 5 * * 1") dispara o snapshot e grava last_backup', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('0 5 * * 1', E, ctx);
    await settle();
    const value = await lastBackupValue();
    expect(value).not.toBeNull();
    expect(JSON.parse(value!).ok).toBe(true);
  });

  it('cron diário ("0 11 * * *") segue no fluxo do digest — NÃO gera backup', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('0 11 * * *', E, ctx);
    await settle(); // runDueReminder roda sem Telegram configurado = no-op seguro
    expect(await lastBackupValue()).toBeNull();
  });

  it('cron diário ("0 11 * * *") computa e cacheia o resurface digest (spec 64)', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('0 11 * * *', E, ctx);
    await settle();
    const value = await resurfaceDigestValue();
    expect(value).not.toBeNull();
    expect(JSON.parse(value!).version).toBe(1);
  });

  it('expressão desconhecida cai no fluxo diário (fail-safe), sem backup', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/5 * * * *', E, ctx);
    await settle();
    expect(await lastBackupValue()).toBeNull();
  });
});
