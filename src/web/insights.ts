import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { domainColor } from './domain-colors.js';
import { brtYearMonth, getMonthInsightsCached, type MonthInsights } from '../db/insights-queries.js';
import { HOME_BOX_DEFAULTS, HOME_BOX_MIN, HOME_BOX_MAX, type HomePrefs } from './home-prefs.js';

// Dashboard "Estatísticas do mês" (specs/91-experiencia-premium/99; rebatizado de
// "Seu cérebro este mês" em 19/07): captura, conexão e execução do mês em BRT,
// com delta vs mês anterior. SSR puro — o gráfico de barras é SVG inline (zero
// lib, zero JS novo).

const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

const monthLabel = (y: number, m: number) => `${MONTHS[m - 1]} de ${y}`;
const ymParam = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const prevYm = (y: number, m: number) => (m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 });
const nextYm = (y: number, m: number) => (m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 });

// "+4" / "-2" / "±0" vs o mês anterior — sinal sempre visível (o delta é a
// história; o número sozinho não diz se cresceu).
function deltaChip(cur: number, prev: number): string {
  const d = cur - prev;
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const label = d > 0 ? `+${d}` : d < 0 ? String(d) : '±0';
  return `<span class="insights-delta ${cls}" title="vs mês anterior">${label}</span>`;
}

// Barras por semana do mês — SVG inline com tokens do tema (var() resolve em
// SVG dentro do DOM, mesmo racional das cores de prioridade da spec 96).
function weekBarsSvg(byWeek: number[]): string {
  const max = Math.max(1, ...byWeek);
  const barW = 100 / byWeek.length;
  const bars = byWeek
    .map((c, i) => {
      const h = Math.round((c / max) * 72);
      const x = i * barW + barW * 0.15;
      return `<rect x="${x.toFixed(1)}%" y="${88 - h}" width="${(barW * 0.7).toFixed(1)}%" height="${Math.max(h, c > 0 ? 3 : 0)}" rx="3" fill="var(--accent-lav)" opacity="0.85"><title>Semana ${i + 1}: ${c}</title></rect>
        <text x="${(i * barW + barW / 2).toFixed(1)}%" y="100" text-anchor="middle" font-size="10" fill="var(--text-subtle)">S${i + 1}</text>
        ${c > 0 ? `<text x="${(i * barW + barW / 2).toFixed(1)}%" y="${82 - h}" text-anchor="middle" font-size="11" fill="var(--text-dim)">${c}</text>` : ''}`;
    })
    .join('');
  return `<svg class="insights-bars" viewBox="0 0 400 104" width="100%" height="104" role="img" aria-label="Notas capturadas por semana">${bars}</svg>`;
}

// Destaque "mais conectada": nota privada NUNCA aparece nomeada (critério de
// aceite) — vira o rótulo neutro, sem link.
function mostConnectedHtml(mc: MonthInsights['mostConnected']): string {
  if (!mc) return '<p class="home-empty">Nenhuma conexão nova neste mês.</p>';
  const name = mc.private
    ? '<em>uma nota privada</em>'
    : `<a href="/app/notes/${esc(mc.id)}">${esc(mc.title)}</a>`;
  return `<p class="insights-note">Mais conectada do mês: ${name} <span class="insights-degree">${mc.degree} conex${mc.degree === 1 ? 'ão' : 'ões'}</span></p>`;
}

function statTile(label: string, value: number, delta?: string): string {
  return `<div class="insights-stat">
    <span class="insights-stat-value">${value}${delta ?? ''}</span>
    <span class="insights-stat-label">${label}</span>
  </div>`;
}

export async function handleInsightsPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();
  const current = brtYearMonth(now);
  // ?m=YYYY-MM — inválido/ausente cai no mês corrente (nunca 500 por query string).
  const mParam = new URL(req.url).searchParams.get('m');
  let { year, month } = current;
  const parsed = mParam?.match(/^(\d{4})-(\d{2})$/);
  if (parsed) {
    const y = parseInt(parsed[1], 10);
    const mo = parseInt(parsed[2], 10);
    if (mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) { year = y; month = mo; }
  }

  const prev = prevYm(year, month);
  const [cur, before] = await Promise.all([
    getMonthInsightsCached(env, year, month, now),
    getMonthInsightsCached(env, prev.year, prev.month, now),
  ]);

  const next = nextYm(year, month);
  const isCurrent = year === current.year && month === current.month;
  const nav = `<div class="insights-nav">
    <a class="btn btn-sm" href="/app/insights?m=${ymParam(prev.year, prev.month)}">← ${MONTHS[prev.month - 1]}</a>
    <span class="insights-month">${monthLabel(year, month)}</span>
    ${isCurrent ? '<span class="insights-nav-spacer"></span>' : `<a class="btn btn-sm" href="/app/insights?m=${ymParam(next.year, next.month)}">${MONTHS[next.month - 1]} →</a>`}
  </div>`;

  const kindChips = cur.byKind.length
    ? `<div class="insights-chips">${cur.byKind.map((k) => `<span class="chip">${esc(k.kind)} <strong>${k.c}</strong></span>`).join('')}</div>`
    : '';
  const domainRows = cur.byDomain.length
    ? `<ul class="insights-domains">${cur.byDomain
        .map((d) => `<li><span class="insights-dot" style="background:${domainColor(d.domain)}"></span>${esc(d.domain)}<strong>${d.c}</strong></li>`)
        .join('')}</ul>`
    : '<p class="home-empty">Nenhuma nota capturada neste mês.</p>';

  const execSplit = cur.tasksDone > 0
    ? `<div class="insights-split" role="img" aria-label="Concluídas: ${cur.tasksDoneOwner} por você, ${cur.tasksDoneAgent} por agentes">
        <div class="insights-split-bar">
          <span class="owner" style="width:${Math.round((cur.tasksDoneOwner / cur.tasksDone) * 100)}%"></span>
          <span class="agent" style="width:${Math.round((cur.tasksDoneAgent / cur.tasksDone) * 100)}%"></span>
        </div>
        <div class="insights-split-legend">
          <span><span class="insights-dot owner"></span>por você <strong>${cur.tasksDoneOwner}</strong></span>
          <span><span class="insights-dot agent"></span>por agentes <strong>${cur.tasksDoneAgent}</strong></span>
        </div>
      </div>`
    : '<p class="home-empty">Nenhuma task concluída neste mês.</p>';

  const body = `
    <div class="page-header"><h1>Estatísticas</h1></div>
    ${nav}
    <div class="insights-stats">
      ${statTile('notas capturadas', cur.captured, deltaChip(cur.captured, before.captured))}
      ${statTile('conexões criadas', cur.edgesCreated, deltaChip(cur.edgesCreated, before.edgesCreated))}
      ${statTile('tasks concluídas', cur.tasksDone, deltaChip(cur.tasksDone, before.tasksDone))}
      ${statTile('ações de agentes', cur.agentActions, deltaChip(cur.agentActions, before.agentActions))}
    </div>
    <div class="insights-grid">
      <section class="card">
        <h2>Captura</h2>
        ${weekBarsSvg(cur.byWeek)}
        ${kindChips}
        ${domainRows}
      </section>
      <section class="card">
        <h2>Conexão</h2>
        <p class="insights-big">${cur.edgesCreated} <span>conex${cur.edgesCreated === 1 ? 'ão' : 'ões'} nova${cur.edgesCreated === 1 ? '' : 's'}</span></p>
        ${mostConnectedHtml(cur.mostConnected)}
      </section>
      <section class="card">
        <h2>Execução</h2>
        <p class="insights-big">${cur.tasksDone} <span>task${cur.tasksDone === 1 ? '' : 's'} concluída${cur.tasksDone === 1 ? '' : 's'}</span></p>
        ${execSplit}
      </section>
      <section class="card">
        <h2>Frota</h2>
        <p class="insights-big">${cur.agentActions} <span>${cur.agentActions === 1 ? 'ação de agente' : 'ações de agentes'}</span></p>
        <p class="insights-note">Escritas de notas e movimentos de tasks feitos por credenciais de agente neste mês. <a href="/app/config#api-keys">Gerenciar agentes →</a></p>
      </section>
    </div>
  `;

  return htmlResponse(
    await renderShell({
      title: 'Estatísticas',
      active: 'insights',
      email: session.email,
      env,
      body,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}

// Card resumo pra home (spec 99 §1): 3 números do mês + delta, dentro do sistema
// de caixas arrastáveis (data-home-item/data-home-box, mesmos data-attrs que o
// home.ts gera — duplicados aqui de propósito: home.ts importa DESTE módulo, o
// contrário criaria ciclo).
export function renderInsightsCard(cur: MonthInsights, prev: MonthInsights, prefs: HomePrefs): string {
  const h = prefs.insights;
  const boxAttrs = ` data-home-item="insights" data-home-box="insights" data-home-default="${HOME_BOX_DEFAULTS.insights}" data-home-min="${HOME_BOX_MIN}" data-home-max="${HOME_BOX_MAX}"${h ? ` style="--home-card-h:${h}px"` : ''}`;
  return `<section class="card home-card"${boxAttrs}>
    <div class="home-resize" aria-hidden="true"></div>
    <h2 class="home-box-handle">Estatísticas <a href="/app/insights">ver detalhes →</a></h2>
    <div class="insights-stats insights-stats-card">
      ${statTile('capturas', cur.captured, deltaChip(cur.captured, prev.captured))}
      ${statTile('conexões', cur.edgesCreated, deltaChip(cur.edgesCreated, prev.edgesCreated))}
      ${statTile('tasks', cur.tasksDone, deltaChip(cur.tasksDone, prev.tasksDone))}
    </div>
  </section>`;
}
