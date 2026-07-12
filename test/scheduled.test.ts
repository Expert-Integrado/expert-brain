import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations } from '../src/db/migrate.js';
import { runScheduled, BACKUP_CRON, trackCronOutcome } from '../src/scheduled.js';
import { LAST_BACKUP_META_KEY } from '../src/backup/snapshot.js';
import { RESURFACE_DIGEST_META_KEY } from '../src/digest/resurface.js';

// Dispatch do cron por expressão (specs/50-console-v2/67-backup-export.md): o
// wrangler.toml agora tem DUAS entradas em [triggers].crons e o Worker decide
// pelo controller.cron. Vive fora de src/index.ts pra ser testável sem carregar
// o OAuth provider / Durable Object.

const E = env as any;
const CRON_JOBS = ['backup', 'similar-repass', 'hygiene-digest', 'due-reminder', 'fleet-watchdog'];

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

async function clearCronKeys(): Promise<void> {
  await E.GRAPH_CACHE.delete('cron:consecutive_failures');
  await E.GRAPH_CACHE.delete('cron:last_error');
  for (const job of CRON_JOBS) {
    await E.GRAPH_CACHE.delete(`cron:${job}:consecutive_failures`);
    await E.GRAPH_CACHE.delete(`cron:${job}:last_error`);
  }
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

describe('runScheduled — trigger consolidado "*/30 * * * *" (spec 80-frota-agentes/89)', () => {
  beforeEach(async () => {
    await clearCronKeys();
  });

  it('firing em :30 roda SÓ o watchdog — nenhum job diário dispara', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 14, 11, 30)); // terça 11:30 UTC
    await settle();
    expect(await E.GRAPH_CACHE.get('cron:fleet-watchdog:consecutive_failures')).toBe('0');
    expect(await lastBackupValue()).toBeNull();
    expect(await resurfaceDigestValue()).toBeNull();
  });

  it('firing segunda 05:00 UTC dispara watchdog + backup', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 13, 5, 0)); // segunda
    await settle();
    expect(await E.GRAPH_CACHE.get('cron:fleet-watchdog:consecutive_failures')).toBe('0');
    const value = await lastBackupValue();
    expect(value).not.toBeNull();
    expect(JSON.parse(value!).ok).toBe(true);
  });

  it('firing 05:00 UTC que NÃO é segunda não gera backup', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 14, 5, 0)); // terça
    await settle();
    expect(await lastBackupValue()).toBeNull();
  });

  it('firing 08:00 UTC dispara o re-pass (cron:similar-repass zera)', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 14, 8, 0));
    await settle();
    expect(await E.GRAPH_CACHE.get('cron:similar-repass:consecutive_failures')).toBe('0');
    expect(await lastBackupValue()).toBeNull();
  });

  it('firing 11:00 UTC dispara o fluxo diário (resurface + due-reminder), sem backup', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 14, 11, 0));
    await settle();
    const value = await resurfaceDigestValue();
    expect(value).not.toBeNull();
    expect(JSON.parse(value!).version).toBe(1);
    expect(await E.GRAPH_CACHE.get('cron:due-reminder:consecutive_failures')).toBe('0');
    expect(await lastBackupValue()).toBeNull();
  });
});

describe('trackCronOutcome — contador de falhas POR JOB + alerta (spec 70-grafo-higiene/76)', () => {
  beforeEach(async () => {
    await clearCronKeys();
  });

  it('sucesso zera o contador do job', async () => {
    await E.GRAPH_CACHE.put('cron:due-reminder:consecutive_failures', '3');
    await trackCronOutcome(E, 'due-reminder', true);
    expect(await E.GRAPH_CACHE.get('cron:due-reminder:consecutive_failures')).toBe('0');
  });

  it('falha incrementa e grava last_error do job', async () => {
    await trackCronOutcome(E, 'due-reminder', false, 'boom');
    expect(await E.GRAPH_CACHE.get('cron:due-reminder:consecutive_failures')).toBe('1');
    const le = JSON.parse((await E.GRAPH_CACHE.get('cron:due-reminder:last_error'))!);
    expect(le.message).toBe('boom');
    expect(le.at).toBeTruthy();
  });

  it('2a falha consecutiva dispara o Telegram (fetch mockado), mensagem com o nome do job', async () => {
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const envTg = { ...E, TELEGRAM_BOT_TOKEN: 'tok-fake', TELEGRAM_CHAT_ID: '1' };
    try {
      await trackCronOutcome(envTg, 'backup', false, 'primeira');
      expect(calls.length).toBe(0); // 1a falha: só contabiliza
      await trackCronOutcome(envTg, 'backup', false, 'segunda');
      expect(calls.length).toBe(1); // 2a falha: alerta
      expect(calls[0]).toContain('api.telegram.org');
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(await E.GRAPH_CACHE.get('cron:backup:consecutive_failures')).toBe('2');
  });

  it('sem secrets de Telegram, 2+ falhas sao no-op sem erro', async () => {
    await trackCronOutcome(E, 'hygiene-digest', false, 'a');
    await trackCronOutcome(E, 'hygiene-digest', false, 'b');
    expect(await E.GRAPH_CACHE.get('cron:hygiene-digest:consecutive_failures')).toBe('2');
  });

  it('jobs diferentes têm contadores ISOLADOS — falha de um não contamina o outro', async () => {
    await trackCronOutcome(E, 'backup', false, 'boom do backup');
    await trackCronOutcome(E, 'similar-repass', true);
    expect(await E.GRAPH_CACHE.get('cron:backup:consecutive_failures')).toBe('1');
    expect(await E.GRAPH_CACHE.get('cron:similar-repass:consecutive_failures')).toBe('0');
  });

  it('due-reminder TAMBÉM escreve as chaves legadas sem sufixo (compat health-check)', async () => {
    await trackCronOutcome(E, 'due-reminder', false, 'boom legado');
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBe('1');
    const le = JSON.parse((await E.GRAPH_CACHE.get('cron:last_error'))!);
    expect(le.message).toBe('boom legado');
    await trackCronOutcome(E, 'due-reminder', true);
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBe('0');
  });

  it('job que NÃO é due-reminder não toca as chaves legadas sem sufixo', async () => {
    await trackCronOutcome(E, 'backup', false, 'boom backup isolado');
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBeNull();
    expect(await E.GRAPH_CACHE.get('cron:last_error')).toBeNull();
  });

  it('handleStatus expõe o bloco cron legado E cron_jobs com os 4 jobs, sem remover campos existentes', async () => {
    // SELF aqui serve o worker do console (src/web/worker.ts), que não roteia
    // /status — o handler é chamado direto, como faz o roteador de src/auth/handler.ts.
    const { handleStatus } = await import('../src/auth/setup.js');
    await E.GRAPH_CACHE.put('cron:consecutive_failures', '1');
    await E.GRAPH_CACHE.put('cron:last_error', JSON.stringify({ at: 'x', message: 'boom' }));
    await E.GRAPH_CACHE.put('cron:backup:consecutive_failures', '2');
    await E.GRAPH_CACHE.put('cron:backup:last_error', JSON.stringify({ at: 'y', message: 'backup boom' }));
    const res = await handleStatus(E);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.configured).toBe(true);
    expect(typeof body.notes).toBe('number'); // campo pré-existente segue
    expect(body.cron.consecutive_failures).toBe(1);
    expect(JSON.parse(body.cron.last_error).message).toBe('boom');
    expect(body.cron_jobs.backup.consecutive_failures).toBe(2);
    expect(JSON.parse(body.cron_jobs.backup.last_error).message).toBe('backup boom');
    expect(body.cron_jobs['similar-repass']).toEqual({ consecutive_failures: 0, last_error: null });
    expect(body.cron_jobs['hygiene-digest']).toEqual({ consecutive_failures: 0, last_error: null });
    expect(body.cron_jobs['due-reminder']).toBeDefined();
    expect(body.cron_jobs['fleet-watchdog']).toBeDefined(); // spec 89

  });

  it('erro do KV nao propaga (alerting nunca derruba o cron)', async () => {
    const broken = {
      ...E,
      GRAPH_CACHE: {
        get: async () => { throw new Error('kv down'); },
        put: async () => { throw new Error('kv down'); },
      },
    };
    await expect(trackCronOutcome(broken, 'due-reminder', false, 'x')).resolves.toBeUndefined();
    await expect(trackCronOutcome(broken, 'due-reminder', true)).resolves.toBeUndefined();
  });
});

describe('runScheduled — wiring de trackCronOutcome por braço (spec 70-grafo-higiene/76)', () => {
  beforeEach(async () => {
    await clearCronKeys();
  });

  it('2 falhas seguidas do braço backup → cron:backup:consecutive_failures=2 + alerta com "backup" no texto; sucesso zera', async () => {
    const calls: { url: string; body: string }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    // MEDIA ausente força runSnapshot a devolver { ok:false, error } sem lançar
    // (o próprio runSnapshot engole o throw interno) — exercita o braço via
    // runScheduled de ponta a ponta, não só trackCronOutcome isolado.
    const brokenMedia = { ...E, MEDIA: undefined, TELEGRAM_BOT_TOKEN: 'tok-fake', TELEGRAM_CHAT_ID: '1' };
    try {
      const first = fakeCtx();
      runScheduled(BACKUP_CRON, brokenMedia, first.ctx);
      await first.settle();
      expect(await E.GRAPH_CACHE.get('cron:backup:consecutive_failures')).toBe('1');
      expect(calls.length).toBe(0);

      const second = fakeCtx();
      runScheduled(BACKUP_CRON, brokenMedia, second.ctx);
      await second.settle();
      expect(await E.GRAPH_CACHE.get('cron:backup:consecutive_failures')).toBe('2');
      expect(calls.length).toBe(1);
      expect(calls[0].body).toContain('backup');
    } finally {
      globalThis.fetch = origFetch;
    }

    // Sucesso (env real, com MEDIA) zera o contador do job.
    const third = fakeCtx();
    runScheduled(BACKUP_CRON, E, third.ctx);
    await third.settle();
    expect(await E.GRAPH_CACHE.get('cron:backup:consecutive_failures')).toBe('0');
  });

  it('braço due-reminder do fluxo diário grava tanto a chave por job quanto a legada', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('0 11 * * *', E, ctx);
    await settle();
    expect(await E.GRAPH_CACHE.get('cron:due-reminder:consecutive_failures')).toBe('0');
    expect(await E.GRAPH_CACHE.get('cron:consecutive_failures')).toBe('0');
  });
});
