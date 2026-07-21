// Frota de agentes (specs/80-frota-agentes/92 + redesign 19/07): a página
// /app/fleet virou redirect pro board — as pendências (perguntas de agentes +
// entregas da coluna Validação humana) moram no bloco "Pendências com você" de
// /app/tasks, que reusa o POST /app/fleet/task de aprovar/devolver. Aqui cobre:
// contagens de hoje (BRT), o redirect, o bloco no board, o POST e o resumo da
// frota na home. Seeds no padrão do fleet-watchdog.test.ts.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import {
  createUser, insertTask, addTaskComment, createKanbanColumn, getTaskById,
} from '../src/db/queries.js';
import { OWNER_TASK_VIS } from '../src/auth/visibility.js';
import { listTaskActivity } from '../src/db/task-activity.js';
import { startOfTodayBrt, fleetActivityToday, listFleetAgents } from '../src/db/fleet-queries.js';
import { agentStatus, agoLabel, FLEET_ACTIVE_WINDOW_MS } from '../src/web/fleet.js';
import { pendingBlockHtml, type PendingItem } from '../src/util/task-badges.js';

const E = env as any;
const H = 3600_000;

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

async function seedTask(id: string, opts: { columnId?: string; status?: 'open' | 'in_progress' | 'done' | 'canceled'; createdAt?: number; createdBy?: string } = {}) {
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'corpo', tldr: id, domains: '["operations"]',
    status: opts.status ?? 'open', due_at: null, priority: null,
    created_at: opts.createdAt ?? 1, updated_at: opts.createdAt ?? 1, completed_at: null,
  });
  if (opts.columnId) {
    await E.DB.prepare(`UPDATE notes SET column_id = ?, status = 'in_progress' WHERE id = ?`).bind(opts.columnId, id).run();
  }
  if (opts.createdBy) {
    await E.DB.prepare(`UPDATE notes SET created_by = ? WHERE id = ?`).bind(opts.createdBy, id).run();
  }
}

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function fleetGet(c: string): Promise<Response> {
  return SELF.fetch('https://example.com/app/fleet', { headers: { cookie: c }, redirect: 'manual' });
}

function fleetPost(fields: Record<string, string>, c?: string): Promise<Response> {
  return SELF.fetch('https://example.com/app/fleet/task', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(c ? { cookie: c } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM task_activity');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
  await E.DB.exec(`DELETE FROM kanban_columns WHERE id LIKE 'col_fleettest%'`);
});

describe('startOfTodayBrt / agentStatus (unit)', () => {
  it('meia-noite BRT: 00:30 BRT conta como hoje; 23:59 BRT é o dia anterior', () => {
    // 12/07 00:30 BRT = 12/07 03:30 UTC → início do dia é 12/07 03:00 UTC.
    expect(startOfTodayBrt(Date.UTC(2026, 6, 12, 3, 30))).toBe(Date.UTC(2026, 6, 12, 3, 0));
    // 12/07 02:59 UTC = 11/07 23:59 BRT → início do dia é 11/07 03:00 UTC.
    expect(startOfTodayBrt(Date.UTC(2026, 6, 12, 2, 59))).toBe(Date.UTC(2026, 6, 11, 3, 0));
  });

  it('badge por régua: sem credencial > sem uso > ativo agora > ativo hoje > dormindo', () => {
    const now = Date.UTC(2026, 6, 12, 15, 0); // 12:00 BRT
    const agent = { id: 'a', name: 'A', hasAvatar: false, hasKey: true };
    expect(agentStatus({ ...agent, hasKey: false }, undefined, now).label).toBe('sem credencial');
    expect(agentStatus(agent, undefined, now).label).toBe('sem uso');
    expect(agentStatus(agent, now - FLEET_ACTIVE_WINDOW_MS + 1000, now).label).toBe('ativo agora');
    expect(agentStatus(agent, now - 2 * H, now).label).toBe('ativo hoje');
    const sleeping = agentStatus(agent, now - 20 * H, now); // 16:00 BRT de ontem
    expect(sleeping.label).toContain('dormindo');
    expect(sleeping.cls).toBe('dim');
  });

  it('agoLabel: minutos, horas, dias', () => {
    const now = 1_700_000_000_000;
    expect(agoLabel(now - 30_000, now)).toBe('agora');
    expect(agoLabel(now - 5 * 60_000, now)).toBe('há 5min');
    expect(agoLabel(now - 3 * H, now)).toBe('há 3h');
    expect(agoLabel(now - 50 * H, now)).toBe('há 2d');
  });
});

describe('fleetActivityToday (queries)', () => {
  it('conta task tocada, task criada, nota (não-task) e comentário — só de hoje', async () => {
    await seedAgent('fa_a', 'PC Test');
    const now = Date.now();
    const start = startOfTodayBrt(now);

    // Task tocada hoje via task_activity (actor = chave do agente).
    await seedTask('ft1');
    await E.DB.prepare(
      `INSERT INTO task_activity (task_id, at, actor, field, old_value, new_value) VALUES (?,?,?,?,?,?)`
    ).bind('ft1', start + 1000, 'key_fa_a', 'status', 'open', 'in_progress').run();
    // A MESMA task tocada de novo não duplica (DISTINCT).
    await E.DB.prepare(
      `INSERT INTO task_activity (task_id, at, actor, field, old_value, new_value) VALUES (?,?,?,?,?,?)`
    ).bind('ft1', start + 2000, 'key_fa_a', 'priority', null, '1').run();
    // Task CRIADA hoje pelo agente (criação não gera activity — braço da união).
    await seedTask('ft2', { createdAt: start + 3000, createdBy: 'key_fa_a' });
    // "Nota" de conhecimento criada hoje (kind != task).
    await seedTask('ft3', { createdAt: start + 4000, createdBy: 'key_fa_a' });
    await E.DB.prepare(`UPDATE notes SET kind = 'concept' WHERE id = 'ft3'`).run();
    // Comentário de hoje, assinado.
    await addTaskComment(E, {
      id: 'fc1', task_id: 'ft1', author: 'agent', author_name: null,
      body: 'oi', created_at: start + 5000, author_user_id: 'fa_a', kind: 'info',
    });
    // Atividade de ONTEM não conta.
    await E.DB.prepare(
      `INSERT INTO task_activity (task_id, at, actor, field, old_value, new_value) VALUES (?,?,?,?,?,?)`
    ).bind('ft1', start - 1000, 'key_fa_a', 'status', 'x', 'y').run();

    const map = await fleetActivityToday(E, now);
    expect(map.get('fa_a')).toEqual({ tasksTouched: 2, notesAuthored: 1, comments: 1 });
  });

  it('agente sem chave ativa segue listado (hasKey=false); chave revogada não conta', async () => {
    await seedAgent('fa_a', 'Com Chave');
    await createUser(E, { id: 'fa_b', name: 'Sem Chave', type: 'agent', bio: null, api_key_id: null }, 1);
    await createUser(E, { id: 'fa_h', name: 'Humano', type: 'person', bio: null, api_key_id: null }, 1);

    let agents = await listFleetAgents(E);
    expect(agents.map((a) => [a.id, a.hasKey])).toEqual([['fa_a', true], ['fa_b', false]]);

    await E.DB.prepare(`UPDATE api_keys SET revoked_at = 1 WHERE id = 'key_fa_a'`).run();
    agents = await listFleetAgents(E);
    expect(agents.find((a) => a.id === 'fa_a')?.hasKey).toBe(false);
  });
});

describe('GET /app/fleet (redirect — a tela saiu da navegação, 19/07)', () => {
  it('302 pro board, com e sem sessão; link antigo não quebra', async () => {
    const anon = await SELF.fetch('https://example.com/app/fleet', { redirect: 'manual' });
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe('/app/tasks');

    const logged = await fleetGet(await cookie());
    expect(logged.status).toBe(302);
    expect(logged.headers.get('location')).toBe('/app/tasks');
  });
});

function boardGet(c: string): Promise<Response> {
  return SELF.fetch('https://example.com/app/tasks', { headers: { cookie: c }, redirect: 'manual' });
}

describe('bloco "Pendências com você" no board (/app/tasks)', () => {
  it('entrega da coluna Validação humana vira item "Para aprovar" com quem entregou e ações inline', async () => {
    await seedAgent('fa_a', 'PC Test');
    await createKanbanColumn(E, { id: 'col_fleettest', label: 'Validação humana', color: null, category: 'in_progress' });
    await seedTask('fv1', { columnId: 'col_fleettest' });
    await addTaskComment(E, {
      id: 'fe1', task_id: 'fv1', author: 'agent', author_name: null,
      body: '[entrega] pronto', created_at: Date.now(), author_user_id: 'fa_a', kind: 'entrega',
    });

    const html = await (await boardGet(await cookie())).text();
    expect(html).toContain('Pendências com você');
    expect(html).toContain('Para aprovar');
    expect(html).toContain('Task fv1');
    expect(html).toContain('PC Test ·');
    // Ações inline reusam o endpoint da antiga fleet.
    expect(html).toContain('action="/app/fleet/task"');
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="return"');
    // Rodada 6: o bloco mora numa gaveta <details> FECHADA por default, com a
    // contagem no <summary> — o board volta a ser a primeira coisa da página.
    expect(html).toContain('class="task-pending-collapse"');
    expect(html).toContain('Pendências com você · 1 (1 para aprovar)');
    expect(html).not.toMatch(/task-pending-collapse"[^>]*\bopen\b/);
    // O nome antigo do banner sumiu da UI.
    expect(html).not.toContain('Aguardando você');
  });

  it('pergunta (bloqueio sem resposta) vira item "Pergunta" com resposta rápida; quem espera há mais tempo vem primeiro', async () => {
    await seedAgent('fa_a', 'PC Test');
    await createKanbanColumn(E, { id: 'col_fleettest', label: 'Validação humana', color: null, category: 'in_progress' });
    // Pergunta esperando desde t=1000; entrega parada desde t=5000 → pergunta primeiro.
    await seedTask('fq1');
    await addTaskComment(E, {
      id: 'fb1', task_id: 'fq1', author: 'agent', author_name: null,
      body: 'Preciso do OK pro deploy', created_at: 1000, author_user_id: 'fa_a', kind: 'bloqueio',
    });
    await seedTask('fv1', { columnId: 'col_fleettest' });
    await E.DB.prepare(`UPDATE notes SET updated_at = 5000 WHERE id = 'fv1'`).run();

    const html = await (await boardGet(await cookie())).text();
    expect(html).toContain('Pergunta');
    expect(html).toContain('Preciso do OK pro deploy');
    // Resposta rápida inline → POST /app/tasks/comment (desarma o bloqueio).
    expect(html).toContain('action="/app/tasks/comment"');
    expect(html.indexOf('Task fq1')).toBeLessThan(html.indexOf('Task fv1'));
    // Summary da gaveta soma as duas filas (rodada 6).
    expect(html).toContain('Pendências com você · 2 (1 pergunta, 1 para aprovar)');
  });
});

describe('pendingBlockHtml (unit)', () => {
  const item = (i: number): PendingItem => ({
    kind: i % 2 === 0 ? 'question' : 'approval', id: `t${i}`, title: `Título ${i}`,
    body: '', author: null, since_brt: '01/07',
  });

  it('mostra as 5 mais urgentes e esconde o resto atrás de "Ver mais (N)"', () => {
    const html = pendingBlockHtml(Array.from({ length: 8 }, (_, i) => item(i)));
    expect(html).toContain('Pendências com você');
    expect(html).toContain('4 perguntas · 4 para aprovar');
    expect(html).toContain('Ver mais (3)');
    // Os 8 itens estão no HTML (os 3 finais dentro do <details>).
    for (let i = 0; i < 8; i++) expect(html).toContain(`Título ${i}`);
  });

  it('vazio → string vazia (o caller esconde o container)', () => {
    expect(pendingBlockHtml([])).toBe('');
  });
});

describe('POST /app/fleet/task (aprovar/devolver)', () => {
  it('approve move pra coluna done default, carimba completed_at e loga activity', async () => {
    await createKanbanColumn(E, { id: 'col_fleettest', label: 'Validação humana', color: null, category: 'in_progress' });
    await seedTask('fv1', { columnId: 'col_fleettest' });

    const res = await fleetPost({ task_id: 'fv1', action: 'approve' }, await cookie());
    expect(res.status).toBe(302);
    // Sem JS o form volta pro board — a página da fleet virou redirect.
    expect(res.headers.get('location')).toBe('/app/tasks');

    const task = await getTaskById(E, 'fv1', OWNER_TASK_VIS);
    expect(task?.status).toBe('done');
    expect(task?.completed_at).not.toBeNull();
    expect(task?.column_id).toBe('col_concluido');
    const activity = await listTaskActivity(E, 'fv1');
    const move = activity.find((a) => a.field === 'column');
    expect(move?.new_value).toBe('Concluído');
  });

  it('return devolve pra execução (in_progress, sem completed_at)', async () => {
    await createKanbanColumn(E, { id: 'col_fleettest', label: 'Validação humana', color: null, category: 'in_progress' });
    await seedTask('fv2', { columnId: 'col_fleettest' });

    const res = await fleetPost({ task_id: 'fv2', action: 'return' }, await cookie());
    expect(res.status).toBe(302);
    const task = await getTaskById(E, 'fv2', OWNER_TASK_VIS);
    expect(task?.status).toBe('in_progress');
    expect(task?.completed_at).toBeNull();
    expect(task?.column_id).toBe('col_progresso');
  });

  it('ação inválida e task inexistente voltam com erro, sem sessão redireciona', async () => {
    const c = await cookie();
    const bad = await fleetPost({ task_id: 'x', action: 'explode' }, c);
    expect(bad.status).toBe(303);
    expect(bad.headers.get('location')).toContain('error=');
    const missing = await fleetPost({ task_id: 'nao-existe', action: 'approve' }, c);
    expect(missing.status).toBe(303);
    const anon = await fleetPost({ task_id: 'x', action: 'approve' });
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toMatch(/^\/app\/login/);
  });

  // O card da home manda back=/app; o guard só honra path interno do console —
  // qualquer outra coisa cai no default. Cobertura server-side pra regressão
  // futura não virar open redirect silencioso (rodada 6).
  it('back=/app é honrado no sucesso E no erro; back externo/fora do console é ignorado', async () => {
    const c = await cookie();
    await createKanbanColumn(E, { id: 'col_fleettest', label: 'Validação humana', color: null, category: 'in_progress' });
    await seedTask('fv3', { columnId: 'col_fleettest' });

    const ok = await fleetPost({ task_id: 'fv3', action: 'approve', back: '/app' }, c);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/app');

    // Erro (task inexistente) também devolve pra onde o dono estava.
    const err = await fleetPost({ task_id: 'nao-existe', action: 'approve', back: '/app' }, c);
    expect(err.status).toBe(303);
    expect(err.headers.get('location')).toMatch(/^\/app\?/);

    // Lixo, URL absoluta e path fora do console: default /app/tasks.
    for (const evil of ['https://evil.example', '//evil.example', '/login', 'javascript:alert(1)']) {
      await seedTask('fv4' + evil.length, { columnId: 'col_fleettest' });
      const res = await fleetPost({ task_id: 'fv4' + evil.length, action: 'approve', back: evil }, c);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/app/tasks');
    }
  });
});

describe('faixa da frota na home', () => {
  it('home mostra "Frota: N ... ativo hoje" e linka o board; sem agentes, sem faixa', async () => {
    const c = await cookie();
    let html = await (await SELF.fetch('https://example.com/app', { headers: { cookie: c }, redirect: 'manual' })).text();
    expect(html).not.toContain('Frota:');

    await seedAgent('fa_a', 'PC Test');
    await touch('key_fa_a', Date.now() - 60_000);
    html = await (await SELF.fetch('https://example.com/app', { headers: { cookie: c }, redirect: 'manual' })).text();
    expect(html).toContain('Frota: 1 de 1 agente ativo hoje');
    // A faixa aponta pro board — a tela de Agentes virou redirect (19/07).
    expect(html).toMatch(/<a class="card card--interactive" href="\/app\/tasks"/);

    // Rodada 6.1: a faixa NÃO conta mais "esperando você" — dois números com
    // definições diferentes (faixa: coluna Validação; card: perguntas +
    // entregas) confundiam. A fila mora só no card "Pendências com você".
    await createKanbanColumn(E, { id: 'col_fleettest', label: 'Validação humana', color: null, category: 'in_progress' });
    await seedTask('fv1', { columnId: 'col_fleettest' });
    html = await (await SELF.fetch('https://example.com/app', { headers: { cookie: c }, redirect: 'manual' })).text();
    expect(html).not.toContain('esperando você');
    expect(html).toContain('Pendências com você');
  });
});
