import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { provisionContacts } from '../../src/contacts-gateway.js';
import { runScheduled } from '../../src/scheduled.js';
import { LAST_BACKUP_KEY } from '../../src/contacts/backup/snapshot.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fusão F3: os crons do antigo worker expert-contacts como braços do trigger
// consolidado "*/30 * * * *" do Brain, despachados por relógio UTC nos MESMOS
// horários do [triggers] antigo — diário 09:00, snapshot segunda 05:30. Esta
// suíte roda COM o módulo bound (DB_CONTACTS/KV_CONTACTS); o caso sem módulo
// (no-op) é coberto na suíte principal (test/scheduled.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

const E = env as any;

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

async function clearContactsCronKeys(): Promise<void> {
  for (const job of ['contacts-maint', 'contacts-gsync', 'contacts-backup']) {
    await E.GRAPH_CACHE.delete(`cron:${job}:consecutive_failures`);
    await E.GRAPH_CACHE.delete(`cron:${job}:last_error`);
  }
  await E.KV_CONTACTS.delete(LAST_BACKUP_KEY);
}

beforeAll(async () => {
  await runMigrations(E);
  await provisionContacts(E);
});

beforeEach(async () => {
  await clearContactsCronKeys();
});

describe('runScheduled — braços do módulo de contatos no trigger consolidado (F3)', () => {
  it('firing segunda 05:30 UTC roda o snapshot do contacts (backup:last no KV_CONTACTS, job ok)', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 13, 5, 30)); // segunda
    await settle();
    const last = await E.KV_CONTACTS.get(LAST_BACKUP_KEY);
    expect(last).not.toBeNull();
    expect(JSON.parse(last!).ok).toBe(true);
    expect(await E.GRAPH_CACHE.get('cron:contacts-backup:consecutive_failures')).toBe('0');
    // E o snapshot foi pro R2 do CONTACTS, não pro do Brain.
    const listed = await E.MEDIA_CONTACTS.list({ limit: 5 });
    expect(listed.objects.length).toBeGreaterThan(0);
  });

  it('firing 05:30 UTC que NÃO é segunda não roda o snapshot do contacts', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 14, 5, 30)); // terça
    await settle();
    expect(await E.KV_CONTACTS.get(LAST_BACKUP_KEY)).toBeNull();
    expect(await E.GRAPH_CACHE.get('cron:contacts-backup:consecutive_failures')).toBeNull();
  });

  it('firing 09:00 UTC roda o fluxo diário do contacts: gsync ok (skipped=not_connected), maint pulado sem PIPEDRIVE_API_KEY', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 14, 9, 0));
    await settle();
    // Google não conectado nesta suíte → { ok:true, skipped } → job conta sucesso.
    expect(await E.GRAPH_CACHE.get('cron:contacts-gsync:consecutive_failures')).toBe('0');
    // Pipedrive desligado (sem secret) → braço nem conta como job (nunca alerta).
    expect(await E.GRAPH_CACHE.get('cron:contacts-maint:consecutive_failures')).toBeNull();
    // E o horário 09:00 não vazou pros outros jobs do Brain.
    expect(await E.KV_CONTACTS.get(LAST_BACKUP_KEY)).toBeNull();
  });

  it('maint com PIPEDRIVE_API_KEY e API fora → job contacts-maint conta falha no Brain', async () => {
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input));
      return new Response('down', { status: 500 });
    }) as typeof fetch;
    try {
      const envPd = { ...E, CONTACTS: undefined, PIPEDRIVE_API_KEY: 'pd-fake' };
      const { ctx, settle } = fakeCtx();
      runScheduled('*/30 * * * *', envPd, ctx, Date.UTC(2026, 6, 14, 9, 0));
      await settle();
      expect(calls.some((u) => u.includes('pipedrive'))).toBe(true);
      expect(await E.GRAPH_CACHE.get('cron:contacts-maint:consecutive_failures')).toBe('1');
      const le = JSON.parse((await E.GRAPH_CACHE.get('cron:contacts-maint:last_error'))!);
      expect(le.message).toContain('pipedrive');
      // Dupla contabilidade: o contador INTERNO do contacts também incrementou
      // (é ele que o /contacts/health expõe — paridade com o worker antigo).
      expect(await E.KV_CONTACTS.get('maint:consecutive_failures')).toBe('1');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('firing 09:30 UTC (minuto :30 fora do horário) não roda nenhum braço do contacts', async () => {
    const { ctx, settle } = fakeCtx();
    runScheduled('*/30 * * * *', E, ctx, Date.UTC(2026, 6, 14, 9, 30));
    await settle();
    expect(await E.GRAPH_CACHE.get('cron:contacts-gsync:consecutive_failures')).toBeNull();
    expect(await E.KV_CONTACTS.get(LAST_BACKUP_KEY)).toBeNull();
  });
});
