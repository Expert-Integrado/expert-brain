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
  return { label: `dormindo · visto ${brtStamp(lastSeen)}`, cls: 'dim', title: `Sem uso desde ${brtStamp(lastSeen)}. ${base}` };
}

// CSS da página via extraHead (padrão do journal) — nada no styles.css global,
// zero rebuild de bundle. O banner de bloqueios reusa .task-awaiting-* do board.
const FLEET_CSS = `
.fleet-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 14px; }
.fleet-agent { display: flex; flex-direction: column; gap: 10px; }
.fleet-agent-head { display: flex; align-items: center; gap: 10px; }
.fleet-avatar { width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; overflow: hidden; }
.fleet-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fleet-agent-name { font-weight: 600; font-size: 15px; }
.fleet-status { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border-strong); white-space: nowrap; }
.fleet-status.ok { color: var(--success); border-color: var(--success-border); }
.fleet-status.dim { color: var(--text-dim); }
.fleet-status.warn { color: #f59e0b; border-color: color-mix(in srgb, #f59e0b 40%, transparent); }
.fleet-agent-stats { font-size: 13px; color: var(--text-dim); margin: 0; }
.fleet-agent-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; font-size: 13px; }
.fleet-mailbox { color: var(--text-dim); }
.fleet-mailbox strong { color: var(--text); }
.fleet-validation { margin-bottom: 18px; }
.fleet-validation-item { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); }
.fleet-validation-item:last-child { border-bottom: 0; }
.fleet-validation-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); text-decoration: none; }
.fleet-validation-title:hover { color: var(--accent-lav); }
.fleet-validation-meta { flex-shrink: 0; color: var(--text-subtle); font-size: 12px; }
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
  const stats =
    a.tasksTouched + a.notesAuthored + a.comments === 0
      ? 'Sem atividade hoje.'
      : `Hoje: ${a.tasksTouched} task${a.tasksTouched === 1 ? '' : 's'} · ${a.notesAuthored} nota${a.notesAuthored === 1 ? '' : 's'} · ${a.comments} comentário${a.comments === 1 ? '' : 's'}`;
  const mailbox = mailboxUnread > 0
    ? `<span class="fleet-mailbox" title="Itens não lidos no mailbox deste agente"><strong>${mailboxUnread}</strong> no mailbox</span>`
    : `<span class="fleet-mailbox">mailbox em dia</span>`;
  return `<section class="card fleet-agent">
    <div class="fleet-agent-head">
      ${agentAvatarHtml(agent)}
      <span class="fleet-agent-name">${esc(agent.name)}</span>
      <span class="fleet-status ${st.cls}" title="${esc(st.title)}">${esc(st.label)}</span>
    </div>
    <p class="fleet-agent-stats">${esc(stats)}</p>
    <div class="fleet-agent-foot">
      ${mailbox}
      <a href="/app/tasks" class="btn btn-sm">Ver no board</a>
    </div>
  </section>`;
}

function validationStripHtml(tasks: ValidationTask[], nowMs: number): string {
  if (tasks.length === 0) return '';
  const rows = tasks
    .map((t) => {
      const who = t.deliveredBy ? `${esc(t.deliveredBy)} · ` : '';
      return `<div class="fleet-validation-item">
        <a class="fleet-validation-title" href="/app/tasks/${esc(t.id)}">${esc(t.title)}</a>
        <span class="fleet-validation-meta">${who}${esc(agoLabel(t.updatedAt, nowMs))}</span>
        <form method="post" action="/app/fleet/task" class="fleet-validation-actions">
          <input type="hidden" name="task_id" value="${esc(t.id)}">
          <button type="submit" name="action" value="approve" class="btn btn-sm btn-primary">Aprovar</button>
          <button type="submit" name="action" value="return" class="btn btn-sm">Devolver</button>
        </form>
      </div>`;
    })
    .join('');
  return `<section class="card fleet-validation">
    <h2>Esperando você <span class="count">${tasks.length}</span></h2>
    <p style="color:var(--text-dim);font-size:13px;margin:0 0 6px">Entregas na coluna Validação humana — aprovar conclui a task; devolver manda de volta pra execução.</p>
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

  const cards = agents
    .map((a) => agentCardHtml(a, lastSeen.get(a.id), activity.get(a.id), unreadByUser.get(a.id) ?? 0, nowMs))
    .join('\n');
  const gridHtml = agents.length === 0
    ? `<div class="empty-state"><p>Nenhum agente na frota ainda — crie usuários tipo agente e vincule credenciais em <a href="/app/config">Configurações</a>.</p></div>`
    : `<div class="fleet-grid">${cards}</div>`;

  const body = `
    <div class="page-header"><h1>Agentes</h1><span class="count">${agents.length}</span></div>
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
