// Dashboard "Seu cérebro este mês" (specs/91-experiencia-premium/99): agregados
// mensais em janela BRT (captura/conexão/execução/frota). Desde a fusão de 19/07
// o dashboard COMPLETO mora no card "Estatísticas" da home (renderInsightsCard)
// e GET /app/insights vira redirect 302 pra /app. Seed determinístico direto no
// D1 — o critério "divisão dono vs agente" é conferível por SQL sobre updated_by.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { monthWindowBrt, getMonthInsights } from '../../src/db/insights-queries.js';
import { renderInsightsCard } from '../../src/web/insights.js';

const E = env as any;
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

// Instante BRT → unix ms (BRT é UTC-3 fixo; 00:30 BRT = 03:30 UTC).
const brt = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h + 3, mi);

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

const insertNote = (
  id: string, title: string, kind: string | null, createdAt: number,
  opts: { deleted?: boolean; private?: boolean; createdBy?: string | null; domains?: string[] } = {}
) =>
  E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_by,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, title, 'corpo', 'tldr', JSON.stringify(opts.domains ?? ['operations']), kind,
    opts.private ? 1 : 0, opts.createdBy ?? null, createdAt, createdAt, opts.deleted ? createdAt : null
  ).run();

const insertDoneTask = (id: string, title: string, completedAt: number, updatedBy: string | null) =>
  E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,completed_at,updated_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'done',?,?,?,?)`
  ).bind(id, title, 'corpo', 'tldr', '["operations"]', 'task', completedAt, updatedBy, completedAt - 1000, completedAt).run();

const insertEdge = (id: string, from: string, to: string, createdAt: number) =>
  E.DB.prepare(
    `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at)
     VALUES (?,?,?,'analogous_to','mecanismo compartilhado de teste com why longo',?)`
  ).bind(id, from, to, createdAt).run();

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);

  // ── Seed do mês de referência: JULHO/2026 (BRT) ──────────────────────────
  // Captura: 3 notas de conhecimento vivas (2 na semana 1, 1 na semana 3),
  // 1 deletada (excluída), 1 criada por agente (conta em captura E em frota).
  await insertNote('ins_n1', 'Nota um de julho', 'concept', brt(2026, 7, 2), { domains: ['operations', 'sales'] });
  await insertNote('ins_n2', 'Nota dois de julho', 'insight', brt(2026, 7, 1, 0, 30)); // 00:30 BRT do dia 1º → mês novo
  await insertNote('ins_n3', 'Nota semana tres', 'concept', brt(2026, 7, 16));
  await insertNote('ins_del', 'Nota deletada de julho', 'fact', brt(2026, 7, 3), { deleted: true });
  await insertNote('ins_agent', 'Nota capturada por agente', 'fact', brt(2026, 7, 5), { createdBy: 'key_agente1' });
  // Nota PRIVADA mais conectada do mês (3 edges) — nunca aparece nomeada.
  await insertNote('ins_priv', 'Segredo industrial XYZW', 'decision', brt(2026, 7, 4), { private: true });
  await insertEdge('ins_e1', 'ins_priv', 'ins_n1', brt(2026, 7, 6));
  await insertEdge('ins_e2', 'ins_priv', 'ins_n3', brt(2026, 7, 7));
  await insertEdge('ins_e3', 'ins_n2', 'ins_priv', brt(2026, 7, 8));
  // Edge com ponta DELETADA (excluída da contagem) e edge de junho (fora da janela).
  await insertEdge('ins_e_del', 'ins_n1', 'ins_del', brt(2026, 7, 9));
  await insertEdge('ins_e_jun', 'ins_n1', 'ins_n2', brt(2026, 6, 20));
  // Execução: 2 done em julho (1 dono oauth, 1 agente PAT), 1 done em junho.
  await insertDoneTask('ins_t1', 'Task do dono', brt(2026, 7, 10), 'oauth:owner@example.com');
  await insertDoneTask('ins_t2', 'Task do agente', brt(2026, 7, 11), 'key_agente1');
  await insertDoneTask('ins_t_jun', 'Task de junho', brt(2026, 6, 15), 'oauth:owner@example.com');
  // Frota: atividade de task por agente (2) e por dono (1, não conta).
  const ta = E.DB.prepare(
    `INSERT INTO task_activity (task_id, at, actor, field, old_value, new_value) VALUES (?,?,?,?,NULL,?)`
  );
  await ta.bind('ins_t2', brt(2026, 7, 11), 'key_agente1', 'status', 'Concluído').run();
  await ta.bind('ins_t2', brt(2026, 7, 11, 13), 'key_agente1', 'column', 'Concluída').run();
  await ta.bind('ins_t1', brt(2026, 7, 10), 'oauth:owner@example.com', 'status', 'Concluído').run();
  // Junho (mês anterior, pro delta): 1 nota de conhecimento.
  await insertNote('ins_jun1', 'Nota de junho', 'concept', brt(2026, 6, 10));
});

describe('monthWindowBrt (spec 99 — janela mensal BRT)', () => {
  it('nota criada dia 1º 00:30 BRT conta no mês NOVO, não no anterior', () => {
    const jul = monthWindowBrt(2026, 7);
    const jun = monthWindowBrt(2026, 6);
    const ts = brt(2026, 7, 1, 0, 30);
    expect(ts >= jul.start && ts < jul.end).toBe(true);
    expect(ts >= jun.start && ts < jun.end).toBe(false);
    // Fronteiras coladas: fim de junho == início de julho.
    expect(jun.end).toBe(jul.start);
  });

  it('início do mês é meia-noite BRT (03:00 UTC)', () => {
    const w = monthWindowBrt(2026, 7);
    expect(w.start).toBe(Date.UTC(2026, 6, 1, 3, 0, 0));
    // Virada de ano: dezembro → janeiro.
    const dez = monthWindowBrt(2026, 12);
    expect(dez.end).toBe(Date.UTC(2027, 0, 1, 3, 0, 0));
  });
});

describe('getMonthInsights (agregados do mês)', () => {
  it('captura: conta notas de conhecimento vivas do mês (deletada fora, task fora)', async () => {
    const m = await getMonthInsights(E, 2026, 7);
    // ins_n1, ins_n2, ins_n3, ins_agent, ins_priv = 5 (ins_del excluída, tasks fora)
    expect(m.captured).toBe(5);
    // Semanas: dias 1-7 → 4 notas; dias 15-21 → 1.
    expect(m.byWeek[0]).toBe(4);
    expect(m.byWeek[2]).toBe(1);
  });

  it('divisão por kind e por domínio (top 5, contagem por slug)', async () => {
    const m = await getMonthInsights(E, 2026, 7);
    const kinds = Object.fromEntries(m.byKind.map((k) => [k.kind, k.c]));
    expect(kinds.concept).toBe(2);
    expect(kinds.insight).toBe(1);
    const doms = Object.fromEntries(m.byDomain.map((d) => [d.domain, d.c]));
    expect(doms.operations).toBe(5); // todas
    expect(doms.sales).toBe(1); // só ins_n1
  });

  it('conexão: edges do mês entre notas vivas; a mais conectada respeita private', async () => {
    const m = await getMonthInsights(E, 2026, 7);
    // ins_e1/e2/e3 contam; ins_e_del (ponta deletada) e ins_e_jun (junho) não.
    expect(m.edgesCreated).toBe(3);
    expect(m.mostConnected?.id).toBe('ins_priv');
    expect(m.mostConnected?.private).toBe(true);
    expect(m.mostConnected?.degree).toBe(3);
  });

  it('execução: tasks concluídas divididas dono vs agente via updated_by', async () => {
    const m = await getMonthInsights(E, 2026, 7);
    expect(m.tasksDone).toBe(2);
    expect(m.tasksDoneOwner).toBe(1);
    expect(m.tasksDoneAgent).toBe(1);
  });

  it('frota: ações de agente = notas criadas por PAT + task_activity de PAT', async () => {
    const m = await getMonthInsights(E, 2026, 7);
    // 1 nota (ins_agent) + 2 task_activity de key_agente1 (a do dono não conta).
    expect(m.agentActions).toBe(3);
  });

  it('mês anterior isolado (junho): 1 nota, 1 task, 1 edge (ins_e_jun cai lá)', async () => {
    const m = await getMonthInsights(E, 2026, 6);
    expect(m.captured).toBe(1);
    expect(m.tasksDone).toBe(1);
    expect(m.edgesCreated).toBe(1);
  });
});

describe('GET /app/insights → redirect (fusão na home, 19/07)', () => {
  it('redireciona 302 pra /app (link antigo não quebra)', async () => {
    const res = await SELF.fetch('https://x.test/app/insights', {
      headers: { cookie: await authCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app');
  });

  it('?m= antigo também redireciona (a navegação por mês morreu com a página)', async () => {
    const res = await SELF.fetch('https://x.test/app/insights?m=2026-06', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app');
  });
});

describe('card "Estatísticas" da home (dashboard completo, fusão 19/07)', () => {
  it('renderInsightsCard traz as 4 seções, o mês e os deltas vs mês anterior', async () => {
    const cur = await getMonthInsights(E, 2026, 7);
    const prev = await getMonthInsights(E, 2026, 6);
    const html = renderInsightsCard(2026, 7, cur, prev);
    expect(html).toContain('julho de 2026');
    for (const s of ['Captura', 'Conexão', 'Execução', 'Frota']) expect(html).toContain(s);
    expect(html).toContain('notas capturadas');
    expect(html).toContain('ações de agentes');
    // Delta de captura: 5 - 1 = +4 vs junho.
    expect(html).toContain('+4');
    // Caixa do sistema da home: âncora da palette + item reordenável + alça +
    // expandido por DEFAULT (dashboard inteiro pede a linha toda).
    expect(html).toContain('id="estatisticas"');
    expect(html).toContain('data-home-item="insights"');
    expect(html).toContain('class="home-resize"');
    expect(html).toContain('home-card-wide');
    // Pref explícita 'normal' vence o default wide.
    const normal = renderInsightsCard(2026, 7, cur, prev, {}, { insights: 'normal' });
    expect(normal).not.toContain('home-card-wide');
    expect(normal).toContain('aria-label="Expandir card"');
  });

  it('nota privada NUNCA aparece nomeada', async () => {
    const cur = await getMonthInsights(E, 2026, 7);
    const prev = await getMonthInsights(E, 2026, 6);
    const html = renderInsightsCard(2026, 7, cur, prev);
    expect(html).not.toContain('Segredo industrial XYZW');
    expect(html.toLowerCase()).toContain('nota privada');
  });

  it('a home inclui o card (caixa insights no grid), sem link pra página extinta', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('data-home-item="insights"');
    expect(html).toContain('id="estatisticas"');
    // Nenhuma referência viva à rota antiga (nem no sidebar, nem no card).
    expect(html).not.toContain('href="/app/insights"');
  });
});
