import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { formError, formErrorBanner } from './form-error.js';
import { awaitingBannerHtml, dotHue, dotInitials } from '../util/task-badges.js';
import {
  listKanbanColumns,
  defaultColumnForCategory,
  moveTaskToColumn,
  lastSeenByUser,
  listAwaitingOwnerBanner,
  type KanbanColumn,
} from '../db/queries.js';
import { getBoardMailboxInfo } from '../db/mailbox.js';
import {
  listFleetAgents,
  fleetActivityToday,
  listValidationTasks,
  startOfTodayBrt,
  type FleetAgent,
  type AgentDayActivity,
  type ValidationTask,
} from '../db/fleet-queries.js';

// Fleet view (specs/80-frota-agentes/92-fleet-view.md): painel operacional da
// frota — quem está vivo (api_keys.last_used_at), o que cada agente fez hoje
// (autoria por credencial) e o que espera o dono (coluna "Validação humana" +
// bloqueios da spec 88). Server-rendered, sem polling; as únicas escritas
// (aprovar/devolver) reusam moveTaskToColumn (invariante coluna→status).

// Thresholds do badge de status (spec 92): "ativo agora" < 15min; "ativo hoje"
// dentro do dia BRT corrente; senão "dormindo desde <última vez>". O draft dizia
// "dormindo > 24h", que deixava um gap entre o dia BRT e 24h — colapsado pra
// régua sem buraco. last_used_at é da CHAVE, não do processo (1 PAT por
// dispositivo, spec 86, é a pré-condição — dito no tooltip).
export const FLEET_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

// Coluna de validação achada por LABEL (não é seed — o dono a criou no board),
// mesmo padrão do update_task stage.
export const VALIDATION_COLUMN_LABEL = 'validação humana';

export function findValidationColumn(cols: KanbanColumn[]): KanbanColumn | null {
  return cols.find((c) => c.label.trim().toLowerCase() === VALIDATION_COLUMN_LABEL) ?? null;
}

function brtStamp(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "há 5min / há 3h / há 2d" — granularidade de painel, não de log.
export function agoLabel(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

interface AgentStatus {
  label: string;
  cls: 'ok' | 'dim' | 'warn';
  title: string;
}

export function agentStatus(agent: FleetAgent, lastSeen: number | undefined, nowMs: number): AgentStatus {
  if (!agent.hasKey) {
    return { label: 'sem credencial', cls: 'warn', title: 'Nenhuma chave ativa vinculada — vincule em Configurações.' };
  }
  const base = 'Último uso de credencial deste agente (1 PAT por dispositivo).';
  if (lastSeen === undefined) return { label: 'sem uso', cls: 'dim', title: `Chave vinculada, nunca usada. ${base}` };
  if (nowMs - lastSeen < FLEET_ACTIVE_WINDOW_MS) {
    return { label: 'ativo agora', cls: 'ok', title: `Visto ${agoLabel(lastSeen, nowMs)} (${brtStamp(lastSeen)}). ${base}` };
  }
  if (lastSeen >= startOfTodayBrt(nowMs)) {
    return { label: 'ativo hoje', cls: 'ok', title: `Visto ${agoLabel(lastSeen, nowMs)} (${brtStamp(lastSeen)}). ${base}` };
  }
  return { label: 'dormindo', cls: 'dim', title: `Sem uso desde ${brtStamp(lastSeen)}. ${base}` };
}

// Linha "visto há Xh" sob o nome — o carimbo sai do badge (que vira dot + rótulo
// curto escaneável) e vira meta secundária, hierarquia de painel operacional.
export function seenLine(agent: FleetAgent, lastSeen: number | undefined, nowMs: number): string {
  if (!agent.hasKey) return 'sem chave ativa';
  if (lastSeen === undefined) return 'chave nunca usada';
  const ago = agoLabel(lastSeen, nowMs);
  return ago === 'agora' ? 'visto agora' : `visto ${ago}`;
}

// Ordem de varredura do grid (alertas e ação primeiro, depois vida): sem
// credencial (quebrado, pede ação do dono) → ativo agora → ativo hoje →
// dormindo (visto mais recente primeiro) → sem uso.
export function agentRank(agent: FleetAgent, lastSeen: number | undefined, nowMs: number): number {
  if (!agent.hasKey) return 0;
  if (lastSeen === undefined) return 4;
  if (nowMs - lastSeen < FLEET_ACTIVE_WINDOW_MS) return 1;
  if (lastSeen >= startOfTodayBrt(nowMs)) return 2;
  return 3;
}

// CSS da página via extraHead (padrão do journal) — nada no styles.css global,
// zero rebuild de bundle. O banner de bloqueios reusa .task-awaiting-* do board.
const FLEET_CSS = `
.fleet-subtitle-row { display: flex; align-items: flex-start; gap: 12px; }
.fleet-subtitle-row .config-subtitle { flex: 1; min-width: 0; }
.fleet-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 14px; }
.fleet-agent { display: flex; flex-direction: column; gap: 12px; }
.fleet-agent--warn { border-left: 3px solid var(--warning, #f59e0b); }
.fleet-agent-head { display: flex; align-items: center; gap: 12px; }
.fleet-avatar { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; overflow: hidden; }
.fleet-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fleet-agent-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.fleet-agent-name { font-family: var(--font-display); font-weight: 500; font-size: 16px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fleet-agent-seen { font-size: 12px; color: var(--text-subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fleet-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); white-space: nowrap; flex-shrink: 0; }
.fleet-state.ok { color: var(--success); }
.fleet-state.warn { color: var(--warning, #f59e0b); }
.fleet-state .status-dot { flex: none; }
.fleet-state .status-dot.pulse { animation: fleet-pulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes fleet-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok, #34d399) 45%, transparent); }
  50% { box-shadow: 0 0 0 5px transparent; }
}
@media (prefers-reduced-motion: reduce) { .fleet-state .status-dot.pulse { animation: none; } }
.fleet-agent-stats { font-size: 13px; color: var(--text-dim); margin: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.fleet-agent-stats .fleet-stat strong { color: var(--text); font-weight: 600; }
.fleet-agent-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); font-size: 12.5px; }
.fleet-mailbox { color: var(--text-dim); }
.fleet-mailbox strong { color: var(--text); }
.fleet-validation { margin-bottom: 18px; }
.fleet-validation-item { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.fleet-validation-item:last-child { border-bottom: 0; padding-bottom: 2px; }
.fleet-validation-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); text-decoration: none; font-size: 14px; }
.fleet-validation-title:hover { color: var(--accent-lav); }
.fleet-validation-meta { flex-shrink: 0; color: var(--text-subtle); font-size: 12px; }
.fleet-validation-meta.stale { color: var(--warning, #f59e0b); }
.fleet-validation-actions { display: flex; gap: 6px; flex-shrink: 0; }
@media (max-width: 767px) {
  .fleet-validation-item { flex-wrap: wrap; }
  .fleet-validation-title { flex-basis: 100%; white-space: normal; }
}
`;

function agentAvatarHtml(agent: FleetAgent): string {
  if (agent.hasAvatar) {
    return `<span class="fleet-avatar"><img src="/app/users/${esc(agent.id)}/avatar" alt=""></span>`;
  }
  return `<span class="fleet-avatar" style="background:hsl(${dotHue(agent.id)} 45% 42%)">${esc(dotInitials(agent.name))}</span>`;
}

function agentCardHtml(
  agent: FleetAgent,
  lastSeen: number | undefined,
  activity: AgentDayActivity | undefined,
  mailboxUnread: number,
  nowMs: number
): string {
  const st = agentStatus(agent, lastSeen, nowMs);
  const a = activity ?? { tasksTouched: 0, notesAuthored: 0, comments: 0 };
  // Números com peso visual (dashboard glanceable): o dado forte é o número,
  // o rótulo é apoio. Zero atividade continua a frase exata dos testes.
  const statParts: string[] = [];
  if (a.tasksTouched > 0) statParts.push(`<span class="fleet-stat" title="Tasks tocadas hoje (BRT)"><strong>${a.tasksTouched}</strong> task${a.tasksTouched === 1 ? '' : 's'}</span>`);
  if (a.notesAuthored > 0) statParts.push(`<span class="fleet-stat" title="Notas criadas ou atualizadas hoje"><strong>${a.notesAuthored}</strong> nota${a.notesAuthored === 1 ? '' : 's'}</span>`);
  if (a.comments > 0) statParts.push(`<span class="fleet-stat" title="Comentários escritos hoje"><strong>${a.comments}</strong> comentário${a.comments === 1 ? '' : 's'}</span>`);
  const stats = statParts.length === 0
    ? `<span class="fleet-stat">Sem atividade hoje.</span>`
    : statParts.join('');
  const mailbox = mailboxUnread > 0
    ? `<span class="fleet-mailbox" title="Menções e avisos que este agente ainda não leu"><strong>${mailboxUnread}</strong> não lido${mailboxUnread === 1 ? '' : 's'} no mailbox</span>`
    : `<span class="fleet-mailbox">mailbox em dia</span>`;
  // Dot no lugar do pill (mesmo vocabulário do restante do console): verde
  // pulsando = ativo agora, verde = ativo hoje, âmbar = sem credencial,
  // cinza = dormindo/sem uso. O carimbo completo continua no title.
  const dotCls = st.cls === 'ok' ? ' is-on' : st.cls === 'warn' ? ' is-warn' : '';
  const pulse = st.label === 'ativo agora' ? ' pulse' : '';
  const seen = !agent.hasKey
    ? `<a href="/app/config#users" style="color:inherit">vincule uma chave em Configurações</a>`
    : esc(seenLine(agent, lastSeen, nowMs));
  return `<section class="card fleet-agent${st.cls === 'warn' ? ' fleet-agent--warn' : ''}">
    <div class="fleet-agent-head">
      ${agentAvatarHtml(agent)}
      <div class="fleet-agent-id">
        <span class="fleet-agent-name">${esc(agent.name)}</span>
        <span class="fleet-agent-seen">${seen}</span>
      </div>
      <span class="fleet-state ${st.cls}" title="${esc(st.title)}"><span class="status-dot${dotCls}${pulse}" aria-hidden="true"></span>${esc(st.label)}</span>
    </div>
    <p class="fleet-agent-stats">${stats}</p>
    <div class="fleet-agent-foot">${mailbox}</div>
  </section>`;
}

function validationStripHtml(tasks: ValidationTask[], nowMs: number): string {
  if (tasks.length === 0) return '';
  const rows = tasks
    .map((t) => {
      const who = t.deliveredBy ? `${esc(t.deliveredBy)} · ` : '';
      // Entrega parada há mais de 24h ganha cor de atenção — a fila é a razão
      // de existir do painel, envelhecer nela é o sinal que importa.
      const stale = nowMs - t.updatedAt > 24 * 60 * 60 * 1000;
      return `<div class="fleet-validation-item">
        <a class="fleet-validation-title" href="/app/tasks/${esc(t.id)}">${esc(t.title)}</a>
        <span class="fleet-validation-meta${stale ? ' stale' : ''}"${stale ? ' title="Esperando há mais de 24h"' : ''}>${who}${esc(agoLabel(t.updatedAt, nowMs))}</span>
        <form method="post" action="/app/fleet/task" class="fleet-validation-actions">
          <input type="hidden" name="task_id" value="${esc(t.id)}">
          <button type="submit" name="action" value="approve" class="btn btn-sm btn-primary">Aprovar</button>
          <button type="submit" name="action" value="return" class="btn btn-sm btn-ghost">Devolver</button>
        </form>
      </div>`;
    })
    .join('');
  return `<section class="card fleet-validation">
    <div class="cfg-head"><h2>Esperando você</h2><span class="cfg-status warn">${tasks.length} entrega${tasks.length === 1 ? '' : 's'}</span></div>
    <p class="cfg-desc">Aprovar conclui a task; devolver manda de volta pra execução.</p>
    ${rows}
  </section>`;
}

export async function handleFleetPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const nowMs = Date.now();

  const [agents, lastSeen, activity, cols] = await Promise.all([
    listFleetAgents(env),
    lastSeenByUser(env),
    fleetActivityToday(env, nowMs),
    listKanbanColumns(env),
  ]);

  // Best-effort, mesmo contrato do board: mailbox/bloqueios nunca derrubam a página.
  let unreadByUser = new Map<string, number>();
  try {
    const info = await getBoardMailboxInfo(env);
    unreadByUser = new Map(info.unreadByUser.map((u) => [u.id, u.count]));
  } catch (e) {
    console.error('fleet: mailbox indisponível (contadores omitidos)', e);
  }
  let awaitingHtml = '';
  try {
    const awaiting = await listAwaitingOwnerBanner(env);
    awaitingHtml = awaitingBannerHtml(
      awaiting.map((it) => ({ ...it, block_at_brt: brtStamp(it.block_at) }))
    );
  } catch (e) {
    console.error('fleet: fila de bloqueios indisponível (banner omitido)', e);
  }

  const valCol = findValidationColumn(cols);
  const validation = valCol ? await listValidationTasks(env, valCol.id) : [];

  // Grid ordenado por estado (alerta primeiro, depois vida) — a ordem de criação
  // não diz nada num painel operacional. Empate dentro do rank: visto mais
  // recente primeiro.
  const sorted = [...agents].sort((a, b) => {
    const ra = agentRank(a, lastSeen.get(a.id), nowMs);
    const rb = agentRank(b, lastSeen.get(b.id), nowMs);
    if (ra !== rb) return ra - rb;
    return (lastSeen.get(b.id) ?? 0) - (lastSeen.get(a.id) ?? 0);
  });
  const cards = sorted
    .map((a) => agentCardHtml(a, lastSeen.get(a.id), activity.get(a.id), unreadByUser.get(a.id) ?? 0, nowMs))
    .join('\n');
  const gridHtml = agents.length === 0
    ? `<div class="empty-state"><p>Nenhum agente na frota ainda — crie usuários tipo agente e vincule credenciais em <a href="/app/config">Configurações</a>.</p></div>`
    : `<div class="fleet-grid">${cards}</div>`;

  // Resposta de 10 segundos já no subtítulo: quantos vivos, o que espera o dono.
  const dayStart = startOfTodayBrt(nowMs);
  const activeToday = agents.filter((a) => (lastSeen.get(a.id) ?? 0) >= dayStart).length;
  const summaryParts: string[] = [];
  if (agents.length > 0) summaryParts.push(`${activeToday} de ${agents.length} ativo${activeToday === 1 ? '' : 's'} hoje`);
  summaryParts.push(
    validation.length > 0
      ? `${validation.length} entrega${validation.length === 1 ? '' : 's'} esperando sua validação`
      : 'nada esperando você'
  );
  const subtitle = agents.length > 0
    ? `<div class="fleet-subtitle-row">
        <p class="config-subtitle">${summaryParts.join(' · ')}</p>
        <a class="btn btn-sm btn-ghost" href="/app/tasks">Abrir board</a>
      </div>`
    : '';

  const body = `
    <div class="page-header"><h1>Agentes</h1><span class="count">${agents.length}</span></div>
    ${subtitle}
    ${formErrorBanner(new URL(req.url))}
    ${awaitingHtml ? `<section class="card fleet-validation">${awaitingHtml}</section>` : ''}
    ${validationStripHtml(validation, nowMs)}
    ${gridHtml}
  `;

  return htmlResponse(
    await renderShell({
      title: 'Agentes',
      active: 'fleet',
      email: session.email,
      env,
      body,
      extraHead: `<style>${FLEET_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}

// Aprovar/devolver da faixa "Esperando você": mover pra coluna default da
// categoria (done / in_progress) via moveTaskToColumn — invariante coluna→status
// e task_activity vêm de graça do caminho já testado do board.
export async function handleFleetTaskActionPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const taskId = String(form.get('task_id') ?? '');
  const action = String(form.get('action') ?? '');
  if (!taskId || (action !== 'approve' && action !== 'return')) {
    return formError(req, 'Ação inválida.', { returnTo: '/app/fleet' });
  }
  const target = await defaultColumnForCategory(env, action === 'approve' ? 'done' : 'in_progress');
  if (!target) return formError(req, 'Nenhuma coluna destino disponível.', { returnTo: '/app/fleet', status: 500 });
  const moved = await moveTaskToColumn(env, taskId, target.id, Date.now(), `oauth:${session.email}`);
  if (moved === 'not-found') return formError(req, 'Task não encontrada.', { returnTo: '/app/fleet', status: 404 });
  if (moved === 'column-not-found') return formError(req, 'Coluna destino não existe mais.', { returnTo: '/app/fleet', status: 500 });
  return new Response(null, { status: 302, headers: { location: '/app/fleet' } });
}

// Resumo pra home ("Frota: N ativos hoje · M esperando você") — acima do grid,
// fora do sistema de caixas (é uma linha de navegação, não um card arrastável).
// Best-effort no caller; retorna '' quando não há frota (home de instância nova
// não ganha faixa vazia).
export async function fleetHomeStripHtml(env: Env, nowMs: number): Promise<string> {
  const [agents, lastSeen, cols] = await Promise.all([
    listFleetAgents(env),
    lastSeenByUser(env),
    listKanbanColumns(env),
  ]);
  if (agents.length === 0) return '';
  const dayStart = startOfTodayBrt(nowMs);
  const activeToday = agents.filter((a) => (lastSeen.get(a.id) ?? 0) >= dayStart).length;
  const valCol = findValidationColumn(cols);
  const waiting = valCol ? (await listValidationTasks(env, valCol.id)).length : 0;
  const waitingHtml = waiting > 0
    ? `<strong>${waiting} esperando você</strong>`
    : 'nada esperando você';
  return `<a class="card card--interactive" href="/app/fleet" style="display:flex;align-items:center;gap:10px;margin-bottom:18px;padding:12px 16px;font-size:13.5px;text-decoration:none;color:var(--text)">
    <span class="status-dot${activeToday > 0 ? ' is-on' : ''}" aria-hidden="true"></span>
    Frota: ${activeToday} de ${agents.length} agente${agents.length === 1 ? '' : 's'} ativo${activeToday === 1 ? '' : 's'} hoje · ${waitingHtml}
  </a>`;
}
