import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations } from '../src/db/migrate.js';
import { runScheduled, BACKUP_CRON, trackCronOutcome } from '../src/scheduled.js';
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

describe('trackCronOutcome — contador de falhas + alerta (spec 40-ops/43)', () => {
  beforeEach(async () => {
    await E.GRAPH_CACHE.delete('cron:consecutive_failures');
    await E.GRAPH_CACHE.delete('cron:last_error');
  });

  it('sucesso zera o contador', async () => {
    await E.GRAPH_CACHE.put('cron:consecutive_failures', '3');
    await trackCronOutcome(E, true);
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBe('0');
  });

  it('falha incrementa e grava last_error', async () => {
    await trackCronOutcome(E, false, 'boom');
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBe('1');
    const le = JSON.parse((await E.GRAPH_CACHE.get('cron:last_error'))!);
    expect(le.message).toBe('boom');
    expect(le.at).toBeTruthy();
  });

  it('2a falha consecutiva dispara o Telegram (fetch mockado)', async () => {
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const envTg = { ...E, TELEGRAM_BOT_TOKEN: 'tok-fake', TELEGRAM_CHAT_ID: '1' };
    try {
      await trackCronOutcome(envTg, false, 'primeira');
      expect(calls.length).toBe(0); // 1a falha: só contabiliza
      await trackCronOutcome(envTg, false, 'segunda');
      expect(calls.length).toBe(1); // 2a falha: alerta
      expect(calls[0]).toContain('api.telegram.org');
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBe('2');
  });

  it('sem secrets de Telegram, 2+ falhas sao no-op sem erro', async () => {
    await trackCronOutcome(E, false, 'a');
    await trackCronOutcome(E, false, 'b');
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBe('2');
  });

  it('handleStatus expõe o bloco cron sem remover campos existentes', async () => {
    // SELF aqui serve o worker do console (src/web/worker.ts), que não roteia
    // /status — o handler é chamado direto, como faz o roteador de src/auth/handler.ts.
    const { handleStatus } = await import('../src/auth/setup.js');
    await E.GRAPH_CACHE.put('cron:consecutive_failures', '1');
    await E.GRAPH_CACHE.put('cron:last_error', JSON.stringify({ at: 'x', message: 'boom' }));
    const res = await handleStatus(E);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.configured).toBe(true);
    expect(typeof body.notes).toBe('number'); // campo pré-existente segue
    expect(body.cron.consecutive_failures).toBe(1);
    expect(JSON.parse(body.cron.last_error).message).toBe('boom');
  });

  it('erro do KV nao propaga (alerting nunca derruba o cron)', async () => {
    const broken = {
      ...E,
      GRAPH_CACHE: {
        get: async () => { throw new Error('kv down'); },
        put: async () => { throw new Error('kv down'); },
      },
    };
    await expect(trackCronOutcome(broken, false, 'x')).resolves.toBeUndefined();
    await expect(trackCronOutcome(broken, true)).resolves.toBeUndefined();
  });
});
