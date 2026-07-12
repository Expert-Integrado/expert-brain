// Watchdog da frota + queries de suporte do spec 80-frota-agentes/89.
// Cobre: streak que arma o monitoramento (4 rodadas = cadência provada), alerta
// único em silêncio >= 2h, zona neutra (35min-2h) congelando o streak sem alertar,
// aviso de retorno + re-arme, agente esporádico que NUNCA alerta, lastSeenByUser
// (max por usuário, ignora chave revogada) e o banner "Aguardando você" do board.
import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { runFleetWatchdog } from '../src/fleet-watchdog.js';
import {
  createUser, insertTask, addTaskComment,
  lastSeenByUser, listAwaitingOwnerBanner,
} from '../src/db/queries.js';

const E = env as any;

const H = 3600_000;
const T0 = 1_700_000_000_000; // âncora fixa — o watchdog só compara diferenças

async function seedAgent(userId: string, name: string, keyId = `key_${userId}`) {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at, user_id)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(keyId, 'o@x', name, `eb_pat_${keyId}`, `h_${keyId}`, 1, userId).run();
  await createUser(E, { id: userId, name, type: 'agent', bio: null, api_key_id: keyId }, 1);
}

async function touch(keyId: string, at: number) {
  await E.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(at, keyId).run();
}

// 4 rodadas de 30min com beat fresco em cada uma → streak 4 (monitorado).
async function proveCadence(keyId: string, from: number): Promise<number> {
  let t = from;
  for (let i = 0; i < 4; i++) {
    await touch(keyId, t);
    await runFleetWatchdog(E, t);
    t += 30 * 60_000;
  }
  return t - 30 * 60_000; // instante do último beat
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
  // KV do watchdog: limpar as chaves dos ids usados nos testes (storage do pool
  // pode sobreviver entre casos do mesmo arquivo).
  for (const id of ['wd_a', 'wd_b']) {
    await E.GRAPH_CACHE.delete(`watchdog:${id}:streak`);
    await E.GRAPH_CACHE.delete(`watchdog:${id}:alerted`);
  }
});

describe('runFleetWatchdog', () => {
  it('cadência provada + silêncio 2h → alerta UMA vez, com nome e horas', async () => {
    await seedAgent('wd_a', 'PC Desktop');
    const lastBeat = await proveCadence('key_wd_a', T0);

    const r1 = await runFleetWatchdog(E, lastBeat + 2 * H + 60_000);
    expect(r1.checked).toBe(1);
    expect(r1.alerts).toHaveLength(1);
    expect(r1.alerts[0]).toContain('PC Desktop');
    expect(r1.alerts[0]).toContain('MUDO há 2h');

    // Rodada seguinte, ainda mudo: flag alerted segura o spam.
    const r2 = await runFleetWatchdog(E, lastBeat + 2 * H + 30 * 60_000);
    expect(r2.alerts).toHaveLength(0);
    expect(r2.recovered).toHaveLength(0);
  });

  it('agente esporádico (streak < 4) NUNCA alerta', async () => {
    await seedAgent('wd_a', 'Alexa Bridge');
    // Só 2 rodadas ativas — cadência não provada.
    await touch('key_wd_a', T0);
    await runFleetWatchdog(E, T0);
    await touch('key_wd_a', T0 + 30 * 60_000);
    await runFleetWatchdog(E, T0 + 30 * 60_000);

    const r = await runFleetWatchdog(E, T0 + 30 * 60_000 + 3 * H);
    expect(r.checked).toBe(1);
    expect(r.alerts).toHaveLength(0);
  });

  it('zona neutra (35min-2h) congela o streak: beat perdido não desarma nem alerta', async () => {
    await seedAgent('wd_a', 'OpenClaw');
    const lastBeat = await proveCadence('key_wd_a', T0);

    // 1h de silêncio: nada dispara, streak segue 4.
    const r = await runFleetWatchdog(E, lastBeat + 1 * H);
    expect(r.alerts).toHaveLength(0);
    expect(await E.GRAPH_CACHE.get('watchdog:wd_a:streak')).toBe('4');

    // Voltou a bater: continua monitorado — silêncio de 2h depois disso alerta.
    await touch('key_wd_a', lastBeat + 90 * 60_000);
    await runFleetWatchdog(E, lastBeat + 90 * 60_000);
    const r2 = await runFleetWatchdog(E, lastBeat + 90 * 60_000 + 2 * H + 60_000);
    expect(r2.alerts).toHaveLength(1);
  });

  it('retorno pós-alerta → aviso de recuperação, flag limpa, re-arma do zero', async () => {
    await seedAgent('wd_a', 'VPS claude-code');
    const lastBeat = await proveCadence('key_wd_a', T0);
    const alertAt = lastBeat + 2 * H + 60_000;
    await runFleetWatchdog(E, alertAt); // dispara o alerta

    // Voltou a bater: recovered + flag limpa; streak recomeçou (1 após esta rodada).
    const backAt = alertAt + 30 * 60_000;
    await touch('key_wd_a', backAt);
    const r = await runFleetWatchdog(E, backAt);
    expect(r.recovered).toHaveLength(1);
    expect(r.recovered[0]).toContain('VPS claude-code');
    expect(await E.GRAPH_CACHE.get('watchdog:wd_a:alerted')).toBeNull();
    expect(await E.GRAPH_CACHE.get('watchdog:wd_a:streak')).toBe('1');

    // Silêncio de 2h AGORA não alerta (streak 1 < 4) — re-arme é do zero, sem spam.
    const r2 = await runFleetWatchdog(E, backAt + 2 * H + 60_000);
    expect(r2.alerts).toHaveLength(0);
  });

  it('agente sem uso de chave fica fora do radar; humano não conta', async () => {
    await seedAgent('wd_a', 'Notebook'); // last_used_at NULL — nunca usou
    await createUser(E, { id: 'wd_b', name: 'Humano', type: 'person', bio: null, api_key_id: null }, 1);
    const r = await runFleetWatchdog(E, T0);
    expect(r.checked).toBe(0);
    expect(r.alerts).toHaveLength(0);
  });
});

describe('lastSeenByUser', () => {
  it('max entre as chaves do usuário; chave revogada não conta', async () => {
    await seedAgent('wd_a', 'PC Desktop');
    await touch('key_wd_a', T0);
    // Segunda chave do MESMO usuário, mais recente.
    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at, user_id, last_used_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind('key2', 'o@x', 'PC Desktop 2', 'eb_pat_key2', 'h_key2', 1, 'wd_a', T0 + H).run();
    expect((await lastSeenByUser(E)).get('wd_a')).toBe(T0 + H);

    // Revogada a mais recente → volta a valer a antiga.
    await E.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = 'key2'`).bind(T0 + 2 * H).run();
    expect((await lastSeenByUser(E)).get('wd_a')).toBe(T0);
  });
});

describe('listAwaitingOwnerBanner', () => {
  async function seedTask(id: string, status: 'open' | 'done' = 'open') {
    await insertTask(E, {
      id, title: `Task ${id}`, body: 'corpo', tldr: id, domains: '["operations"]',
      status, due_at: null, priority: null, created_at: T0, updated_at: T0,
      completed_at: status === 'done' ? T0 : null,
    });
  }

  it('bloqueio sem resposta do dono entra com corpo e autor; resposta do dono limpa', async () => {
    await seedAgent('wd_a', 'PC Desktop');
    await seedTask('t1');
    await addTaskComment(E, {
      id: 'c1', task_id: 't1', author: 'agent', author_name: null,
      body: 'Preciso do OK pro deploy', created_at: T0 + 1,
      author_user_id: 'wd_a', kind: 'bloqueio',
    });

    const items = await listAwaitingOwnerBanner(E);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 't1', title: 'Task t1',
      block_body: 'Preciso do OK pro deploy',
      block_author: 'PC Desktop', block_at: T0 + 1,
    });

    await addTaskComment(E, {
      id: 'c2', task_id: 't1', author: 'owner', author_name: null,
      body: 'pode ir', created_at: T0 + 2,
    });
    expect(await listAwaitingOwnerBanner(E)).toHaveLength(0);
  });

  it('ordena pelo bloqueio mais antigo primeiro; task fechada sai', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await addTaskComment(E, { id: 'c1', task_id: 't1', author: 'agent', author_name: null, body: 'b1', created_at: T0 + 10, kind: 'bloqueio' });
    await addTaskComment(E, { id: 'c2', task_id: 't2', author: 'agent', author_name: null, body: 'b2', created_at: T0 + 5, kind: 'bloqueio' });
    expect((await listAwaitingOwnerBanner(E)).map((i) => i.id)).toEqual(['t2', 't1']);

    await E.DB.prepare(`UPDATE notes SET status = 'done' WHERE id = 't2'`).run();
    expect((await listAwaitingOwnerBanner(E)).map((i) => i.id)).toEqual(['t1']);
  });
});
