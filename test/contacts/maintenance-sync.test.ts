import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMaintenanceSync } from '../../src/contacts/index';

// Cron Pipedrive robusto (spec 10-backend/22): janela nunca avança em erro,
// teto de trabalho vira checkpoint retomável, token vai no header.

const E = env as any;

const ORIG_FETCH = globalThis.fetch;
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];

function mockPd(responder: (url: string) => { status: number; body?: any } | 'throw') {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    const h = input instanceof Request ? input.headers : new Headers(init?.headers);
    h.forEach((v: string, k: string) => { headers[k] = v; });
    fetchCalls.push({ url, headers });
    const r = responder(url);
    if (r === 'throw') throw new Error('network down');
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

// Página do /recents com N persons "vazias" (sem telefone => processadas e puladas).
function recentsPage(n: number, more: boolean, nextStart: number) {
  return {
    data: Array.from({ length: n }, (_, i) => ({ item: 'person', data: { id: i, phone: [], email: [] } })),
    additional_data: { pagination: { more_items_in_collection: more, next_start: nextStart } },
  };
}

const envPd = () => ({ ...E, PIPEDRIVE_API_KEY: 'pd-key-fake' });

beforeEach(async () => {
  fetchCalls = [];
  for (const k of ['maint:last_run', 'maint:cursor', 'maint:consecutive_failures', 'maint:alert']) {
    await E.CACHE.delete(k);
  }
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('handleMaintenanceSync (spec 10-backend/22)', () => {
  it('token no header x-api-token, nunca na URL', async () => {
    mockPd(() => ({ status: 200, body: recentsPage(0, false, 0) }));
    await handleMaintenanceSync(envPd());
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const c of fetchCalls) {
      expect(c.url).not.toContain('api_token');
      expect(c.headers['x-api-token']).toBe('pd-key-fake');
    }
  });

  it('401 => ok:false, last_run NAO gravado, contador incrementa', async () => {
    mockPd(() => ({ status: 401 }));
    const r = await handleMaintenanceSync(envPd());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(await E.CACHE.get('maint:last_run')).toBeNull();
    expect(await E.CACHE.get('maint:consecutive_failures')).toBe('1');
  });

  it('erro de rede (fetch lanca) => mesmo comportamento do 401, status 0', async () => {
    mockPd(() => 'throw');
    const r = await handleMaintenanceSync(envPd());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(await E.CACHE.get('maint:last_run')).toBeNull();
  });

  it('2 falhas consecutivas => maint:alert com maint_sync_failing', async () => {
    mockPd(() => ({ status: 500 }));
    await handleMaintenanceSync(envPd());
    await handleMaintenanceSync(envPd());
    expect(await E.CACHE.get('maint:consecutive_failures')).toBe('2');
    const alert = JSON.parse((await E.CACHE.get('maint:alert'))!);
    expect(alert.kind).toBe('maint_sync_failing');
    expect(alert.consecutive).toBe(2);
  });

  it('sucesso com 0 resultados => last_run = INICIO do run, contador zerado', async () => {
    await E.CACHE.put('maint:consecutive_failures', '3');
    mockPd(() => ({ status: 200, body: recentsPage(0, false, 0) }));
    const before = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const r = await handleMaintenanceSync(envPd());
    expect(r.ok).toBe(true);
    const lastRun = await E.CACHE.get('maint:last_run');
    expect(lastRun).not.toBeNull();
    expect(lastRun! >= before).toBe(true);
    expect(await E.CACHE.get('maint:consecutive_failures')).toBe('0');
  });

  it('volume acima do teto => partial:true, cursor gravado, last_run intacto', async () => {
    // Sempre "tem mais": o teto (MAINT_MAX_PERSONS=150) corta na 2a pagina.
    let call = 0;
    mockPd(() => ({ status: 200, body: recentsPage(100, true, 100 * ++call) }));
    const r = await handleMaintenanceSync({ ...envPd(), MAINT_MAX_PERSONS: '150' });
    expect(r.ok).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.processed).toBe(200); // 2 paginas inteiras (nao corta no meio da pagina)
    const cursor = JSON.parse((await E.CACHE.get('maint:cursor'))!);
    expect(cursor.next_start).toBe(200);
    expect(cursor.since).toBeTruthy();
    expect(cursor.run_started_at).toBeTruthy();
    expect(await E.CACHE.get('maint:last_run')).toBeNull();
  });

  it('retomada de cursor: comeca no next_start e, ao drenar, grava last_run do cursor e apaga o cursor', async () => {
    await E.CACHE.put('maint:cursor', JSON.stringify({
      since: '2026-07-02 09:00:00',
      run_started_at: '2026-07-03 09:00:01',
      next_start: 300,
    }));
    mockPd(() => ({ status: 200, body: recentsPage(50, false, 0) }));
    const r = await handleMaintenanceSync(envPd());
    expect(r.ok).toBe(true);
    expect(r.partial).toBeUndefined();
    // Retomou da janela e offset do cursor.
    expect(fetchCalls[0].url).toContain('start=300');
    expect(fetchCalls[0].url).toContain(encodeURIComponent('2026-07-02 09:00:00'));
    // Drenou: last_run = run_started_at DO CURSOR (nao o de agora), cursor apagado.
    expect(await E.CACHE.get('maint:last_run')).toBe('2026-07-03 09:00:01');
    expect(await E.CACHE.get('maint:cursor')).toBeNull();
  });

  it('erro no meio de retomada mantem o cursor intacto', async () => {
    const cursor = { since: '2026-07-02 09:00:00', run_started_at: '2026-07-03 09:00:01', next_start: 300 };
    await E.CACHE.put('maint:cursor', JSON.stringify(cursor));
    mockPd(() => ({ status: 503 }));
    const r = await handleMaintenanceSync(envPd());
    expect(r.ok).toBe(false);
    expect(JSON.parse((await E.CACHE.get('maint:cursor'))!)).toEqual(cursor);
    expect(await E.CACHE.get('maint:last_run')).toBeNull();
  });

  it('sem PIPEDRIVE_API_KEY => ok:false sem tocar em fetch', async () => {
    mockPd(() => ({ status: 200, body: recentsPage(0, false, 0) }));
    const r = await handleMaintenanceSync({ ...E, PIPEDRIVE_API_KEY: undefined });
    expect(r.ok).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });
});
