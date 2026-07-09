import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { getVaultStatus } from '../auth/setup.js';
import { listApiKeys } from '../auth/api-keys.js';
import { flashKvKey } from './api-keys.js';
import { readPersonalizationPrompt, readOwnerInstructions, writeOwnerInstructions, OWNER_INSTRUCTIONS_MAX_LEN } from '../db/meta.js';
import { assetVersion } from './asset-version.js';
import { readLastBackup } from '../backup/snapshot.js';
import { formatBrtDateTime } from '../util/time.js';
import { TASK_STATUSES, type TaskStatus, type KanbanColumn, listKanbanColumns, taskCountsByColumn, type TaskProject, TASK_PROJECT_CAP, listTaskProjects, taskCountsByProject, KNOWLEDGE_KINDS, listDomainCounts } from '../db/queries.js';
import { resolveDomainMeta, resolveKindMeta } from './domain-colors.js';
import { getTaxonomyConfig, mergedDomainSlugs } from './taxonomy-config.js';
import { listUsers } from '../db/queries.js';
import { renderUsersSection, USERS_SECTION_CSS } from './users.js';

// Template padrão pra primeira visita — placeholders entre [colchetes] que o
// usuário substitui pelo próprio contexto. O texto fica editável inline em
// /app/config e persiste na tabela `meta` com a chave `personalization_prompt`.
const DEFAULT_PREFS_BLOCK = `Expert Brain está conectado como servidor MCP — é meu grafo de conhecimento pessoal cross-domain.

Contexto: sou [seu nome]. Trabalho com [suas áreas/domínios principais — ex: gestão, vendas, educação, IA aplicada].

Comportamento esperado:
- Antes de responder perguntas conceituais ou estratégicas, consulte o vault em busca de analogias — especialmente de domínios diferentes do tema da conversa.
- Quando eu compartilhar uma ideia, decisão ou aprendizado que vale preservar, ofereça salvar. Se eu concordar: atomize em um conceito por nota, escolha um domínio específico, varra outros domínios em busca de analogias estruturais, e crie conexões com justificativa do mecanismo compartilhado.
- Quando eu perguntar sobre algo que pode estar no vault, prefira buscar lá antes de responder do zero.
- Não use o vault em tarefas operacionais (código, debug, tarefas do dia a dia) — só para ideias, insights, decisões e aprendizados que valem ser reencontrados no futuro.`;

const PREFS_META_KEY = 'personalization_prompt';
const PREFS_MAX_LEN = 8000;

async function getPersonalizationPrompt(env: Env): Promise<string> {
  return (await readPersonalizationPrompt(env)) ?? DEFAULT_PREFS_BLOCK;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ─────────────── Seção "Quadro de tarefas" (Kanban — spec 51) ───────────────
// Rótulos pt-BR das 4 categorias canônicas (imutáveis) usados no select/badge.
const CATEGORY_LABELS: Record<TaskStatus, string> = {
  open: 'A fazer',
  in_progress: 'Em progresso',
  done: 'Concluído',
  canceled: 'Cancelado',
};

const categoryOptions = (selected?: TaskStatus): string =>
  TASK_STATUSES.map(
    (c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${esc(CATEGORY_LABELS[c])}</option>`
  ).join('');

function renderColumnRow(col: KanbanColumn, count: number, activeSameCat: KanbanColumn[]): string {
  const archived = col.archived_at !== null;
  const colorVal = col.color ?? '';
  // Destino pras tasks ao arquivar uma coluna ATIVA que tem tasks (mesma categoria).
  const destOptions = activeSameCat
    .filter((c) => c.id !== col.id)
    .map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`)
    .join('');
  const archiveCell = archived
    ? `<form method="post" action="/app/tasks/columns/archive" style="display:inline">
         <input type="hidden" name="id" value="${esc(col.id)}">
         <input type="hidden" name="archived" value="0">
         <button type="submit">Desarquivar</button>
       </form>`
    : `<form method="post" action="/app/tasks/columns/archive" class="row" style="gap:6px;align-items:center">
         <input type="hidden" name="id" value="${esc(col.id)}">
         <input type="hidden" name="archived" value="1">
         ${count > 0 ? `<select name="to" required><option value="">mover ${count} task${count === 1 ? '' : 's'} p/…</option>${destOptions}</select>` : ''}
         <button type="submit" class="btn btn-danger btn-sm">Arquivar</button>
       </form>`;
  return `<tr${archived ? ' style="opacity:0.55"' : ''}>
    <td>
      <form method="post" action="/app/tasks/columns/update" class="row" style="gap:6px;align-items:center">
        <input type="hidden" name="id" value="${esc(col.id)}">
        <input type="text" name="label" value="${esc(col.label)}" maxlength="40" class="input-text" style="width:150px">
        <input type="text" name="color" value="${esc(colorVal)}" placeholder="#rrggbb" maxlength="7" class="input-text" style="width:92px">
        <button type="submit">Salvar</button>
      </form>
    </td>
    <td><span class="badge-pill">${esc(CATEGORY_LABELS[col.category])}</span></td>
    <td>
      <form method="post" action="/app/tasks/columns/reorder" style="display:inline">
        <input type="hidden" name="id" value="${esc(col.id)}"><input type="hidden" name="direction" value="up">
        <button type="submit" aria-label="Subir">↑</button>
      </form>
      <form method="post" action="/app/tasks/columns/reorder" style="display:inline">
        <input type="hidden" name="id" value="${esc(col.id)}"><input type="hidden" name="direction" value="down">
        <button type="submit" aria-label="Descer">↓</button>
      </form>
    </td>
    <td>${count}</td>
    <td>${archiveCell}</td>
  </tr>`;
}

function renderBoardSection(columns: KanbanColumn[], counts: Map<string, number>, savedBoard: boolean): string {
  const activeByCat = new Map<TaskStatus, KanbanColumn[]>();
  for (const c of columns) {
    if (c.archived_at === null) {
      const arr = activeByCat.get(c.category) ?? [];
      arr.push(c);
      activeByCat.set(c.category, arr);
    }
  }
  const rows = columns
    .map((c) => renderColumnRow(c, counts.get(c.id) ?? 0, activeByCat.get(c.category) ?? []))
    .join('');
  return `
    <details class="disclosure-advanced conn-section" id="board"${savedBoard ? ' open' : ''}>
      <summary>
        <span class="adv-title">Quadro de tarefas</span>
        <span class="adv-sub">Colunas/estágios do Kanban — crie, renomeie, recolora, reordene e arquive</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>As colunas do board <a href="/app/tasks">/app/tasks</a> vêm daqui. Cada coluna pertence a uma das 4 categorias fixas (<em>${TASK_STATUSES.map((c) => esc(CATEGORY_LABELS[c])).join(', ')}</em>), que definem o estado real da task — a categoria é travada após a criação. Arrastar um card pra uma coluna aplica a categoria dela.</p>
          <table class="keys-table">
            <thead><tr>
              <th>Coluna (nome + cor)</th><th>Categoria</th><th>Ordem</th><th>Tarefas</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="adv-section">
          <h3>Nova coluna</h3>
          <form method="post" action="/app/tasks/columns/create" class="row" style="gap:12px;flex-wrap:wrap;align-items:flex-end">
            <div style="display:flex;flex-direction:column;gap:4px">
              <label for="new-col-label" style="font-size:12px;color:var(--text-dim)">Nome da coluna</label>
              <input id="new-col-label" type="text" name="label" required maxlength="40" placeholder="Ex.: Backlog" class="input-text" style="width:170px">
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label for="new-col-color" style="font-size:12px;color:var(--text-dim)">Cor (opcional)</label>
              <input id="new-col-color" type="text" name="color" placeholder="#rrggbb" maxlength="7" class="input-text" style="width:130px">
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label for="new-col-category" style="font-size:12px;color:var(--text-dim)">Categoria (estado real da task)</label>
              <select id="new-col-category" name="category" required>${categoryOptions('open')}</select>
            </div>
            <button type="submit" class="btn btn-primary">Criar coluna</button>
          </form>
          <p style="color:var(--text-dim);font-size:13px;margin-top:8px">Ex.: uma coluna <strong>Backlog</strong> pertence à categoria <strong>Aberta</strong> — a categoria é o estado REAL da task (o que o MCP e as automações leem); a coluna é só o estágio visual no board.</p>
          <p style="color:var(--text-dim);font-size:13px;margin-top:8px">A coluna <strong>Cancelado</strong> nasce arquivada — desarquive-a aqui pra ver tasks canceladas no board.</p>
        </div>
      </div>
    </details>`;
}

// ─────────────── Seção "Projetos" (pastas de task — spec 58) ───────────────
function renderProjectRow(proj: TaskProject, count: number): string {
  const archived = proj.archived_at !== null;
  const colorVal = proj.color ?? '';
  const archiveCell = archived
    ? `<form method="post" action="/app/tasks/projects/archive" style="display:inline">
         <input type="hidden" name="id" value="${esc(proj.id)}">
         <input type="hidden" name="archived" value="0">
         <button type="submit">Desarquivar</button>
       </form>`
    : `<form method="post" action="/app/tasks/projects/archive" style="display:inline">
         <input type="hidden" name="id" value="${esc(proj.id)}">
         <input type="hidden" name="archived" value="1">
         <button type="submit" class="btn btn-danger btn-sm">Arquivar</button>
       </form>`;
  return `<tr${archived ? ' style="opacity:0.55"' : ''}>
    <td>
      <form method="post" action="/app/tasks/projects/update" class="row" style="gap:6px;align-items:center">
        <input type="hidden" name="id" value="${esc(proj.id)}">
        <input type="text" name="label" value="${esc(proj.label)}" maxlength="40" class="input-text" style="width:170px">
        <input type="text" name="color" value="${esc(colorVal)}" placeholder="#rrggbb" maxlength="7" class="input-text" style="width:92px">
        <button type="submit">Salvar</button>
      </form>
    </td>
    <td>
      <form method="post" action="/app/tasks/projects/reorder" style="display:inline">
        <input type="hidden" name="id" value="${esc(proj.id)}"><input type="hidden" name="direction" value="up">
        <button type="submit" aria-label="Subir">↑</button>
      </form>
      <form method="post" action="/app/tasks/projects/reorder" style="display:inline">
        <input type="hidden" name="id" value="${esc(proj.id)}"><input type="hidden" name="direction" value="down">
        <button type="submit" aria-label="Descer">↓</button>
      </form>
    </td>
    <td>${count}</td>
    <td>${archiveCell}</td>
  </tr>`;
}

function renderProjectsSection(projects: TaskProject[], counts: Map<string, number>, savedProjects: boolean): string {
  const total = projects.length;
  const rows = projects.length
    ? projects.map((p) => renderProjectRow(p, counts.get(p.id) ?? 0)).join('')
    : `<tr><td colspan="4" style="color:var(--text-dim)">Nenhum projeto ainda. Crie um abaixo, ou deixe a task sem projeto (o padrão).</td></tr>`;
  const atCap = total >= TASK_PROJECT_CAP;
  return `
    <details class="disclosure-advanced conn-section" id="projects"${savedProjects ? ' open' : ''}>
      <summary>
        <span class="adv-title">Projetos</span>
        <span class="adv-sub">Pastas de tarefas — agrupe tasks por projeto, com cor e ciclo de vida (arquivar)</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Projeto é uma <strong>pasta</strong> de tarefas: single-valorado (cada task pertence a 0 ou 1 projeto), com cor e filtro próprio no board <a href="/app/tasks">/app/tasks</a>. Diferente de <em>tag</em> (rótulo transversal, multi). Arquivar um projeto <strong>não mexe nas tasks</strong> — elas continuam no board (chip esmaecido), o projeto só some dos seletores. ${total}/${TASK_PROJECT_CAP} projetos.</p>
          <table class="keys-table">
            <thead><tr>
              <th>Projeto (nome + cor)</th><th>Ordem</th><th>Tarefas</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="adv-section">
          <h3>Novo projeto</h3>
          ${atCap
            ? `<p style="color:var(--text-dim)">Limite de ${TASK_PROJECT_CAP} projetos atingido. Arquive um projeto sem uso antes de criar outro.</p>`
            : `<form method="post" action="/app/tasks/projects/create" class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
            <input type="text" name="label" required maxlength="40" placeholder="Nome do projeto" class="input-text" style="width:200px">
            <input type="text" name="color" placeholder="#rrggbb (opcional)" maxlength="7" class="input-text" style="width:150px">
            <button type="submit" class="btn btn-primary">Criar projeto</button>
          </form>`}
        </div>
      </div>
    </details>`;
}

// ─────────────── Seção "Áreas e tipos" (taxonomia configurável — spec 54) ───────────────
function renderDomainRow(slug: string, label: string, color: string, count: number): string {
  return `<tr data-slug="${esc(slug)}">
    <td><input type="color" class="tax-swatch" value="${esc(color)}" aria-label="Cor de ${esc(slug)}"></td>
    <td><input type="text" class="input-text tax-label-input" value="${esc(label)}" maxlength="40" aria-label="Nome de exibição de ${esc(slug)}"></td>
    <td><code>${esc(slug)}</code></td>
    <td>${count}</td>
  </tr>`;
}

function renderKindRow(kind: string, label: string, color: string): string {
  return `<tr data-kind="${esc(kind)}">
    <td><input type="color" class="tax-swatch" value="${esc(color)}" aria-label="Cor de ${esc(kind)}"></td>
    <td><input type="text" class="input-text tax-label-input" value="${esc(label)}" maxlength="40" aria-label="Nome de exibição de ${esc(kind)}"></td>
    <td><code>${esc(kind)}</code></td>
  </tr>`;
}

function renderTaxonomySection(
  domainCounts: Record<string, number>,
  taxonomy: { domains: Record<string, { label: string; color: string }>; kinds: Record<string, { label: string; color: string }> },
  savedTaxonomy: boolean
): string {
  const domainSlugs = mergedDomainSlugs(taxonomy, Object.keys(domainCounts));
  const domainRows = domainSlugs
    .map((slug) => {
      const meta = resolveDomainMeta(slug, taxonomy);
      return renderDomainRow(slug, meta.label, meta.color, domainCounts[slug] ?? 0);
    })
    .join('');
  const kindRows = KNOWLEDGE_KINDS
    .map((k) => {
      const meta = resolveKindMeta(k, taxonomy);
      return renderKindRow(k, meta.label, meta.color);
    })
    .join('');
  return `
    <details class="disclosure-advanced conn-section" id="taxonomy"${savedTaxonomy ? ' open' : ''}>
      <summary>
        <span class="adv-title">Áreas e tipos</span>
        <span class="adv-sub">Cor e nome de exibição das áreas (domains) e tipos (kinds) — crie áreas novas aqui</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <h3>Áreas</h3>
          <p>O <strong>slug</strong> é a chave canônica (MCP, grafo, filtros) — mudar cor ou nome aqui é só exibição: não renomeia o slug, não move nenhuma nota.</p>
          <table class="keys-table">
            <thead><tr><th>Cor</th><th>Nome de exibição</th><th>Slug</th><th>Notas</th></tr></thead>
            <tbody id="taxonomy-domains-body">${domainRows}</tbody>
          </table>
          <div class="row" style="gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap">
            <input type="text" id="tax-new-label" placeholder="Nome da nova área (ex: Vida Pessoal)" maxlength="40" class="input-text" style="width:220px">
            <button type="button" id="tax-add-domain">+ Nova área</button>
          </div>
          <p id="tax-new-error" class="tax-inline-error" style="display:none"></p>
        </div>
        <div class="adv-section">
          <h3>Tipos (kinds)</h3>
          <p>Os 7 tipos são fixos (enum estrutural do MCP) — só cor e nome de exibição são editáveis; criar/excluir kind está fora de escopo aqui.</p>
          <table class="keys-table">
            <thead><tr><th>Cor</th><th>Nome de exibição</th><th>Kind</th></tr></thead>
            <tbody id="taxonomy-kinds-body">${kindRows}</tbody>
          </table>
        </div>
        <div class="row" style="gap:8px">
          <button type="button" id="taxonomy-save" class="btn btn-primary">Salvar</button>
          <button type="button" id="taxonomy-reset" class="btn btn-danger btn-sm">Restaurar padrão</button>
        </div>
        <p id="taxonomy-status" class="tax-inline-status" role="status" aria-live="polite"></p>
      </div>
    </details>`;
}

// ─────────── Seção "Instruções pros agentes (MCP)" — CLAUDE.md do Brain (spec 70) ───────────
function renderOwnerInstructionsSection(ownerInstructions: string, savedOwner: boolean): string {
  const len = ownerInstructions.length;
  return `
    <details class="disclosure-advanced conn-section" id="owner-instructions"${savedOwner ? ' open' : ''}>
      <summary>
        <span class="adv-title">Instruções pros agentes (MCP)</span>
        <span class="adv-sub">Um "CLAUDE.md do Brain": orientações suas que TODO agente recebe no handshake</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Este texto é anexado às instruções que o servidor MCP anuncia no <strong>handshake</strong> — ou seja, TODO agente que conecta (Claude Code, Desktop, sistemas web, automações) recebe estas orientações automaticamente, sem você configurar cliente por cliente. Use pra regras globais tipo <em>"sempre responda em pt-BR"</em>, <em>"priorize o domínio X"</em> ou <em>"nunca crie task sem prazo"</em>.</p>
          <form method="post" action="/app/config/owner-instructions">
            <label for="owner-instructions-text">Instruções (texto puro/markdown leve, máx ${OWNER_INSTRUCTIONS_MAX_LEN} caracteres)</label>
            <textarea id="owner-instructions-text" name="owner_instructions" rows="8" maxlength="${OWNER_INSTRUCTIONS_MAX_LEN}" class="prefs-textarea" data-charcount="owner-instructions-count" placeholder="Ex: Sempre responda em pt-BR. Antes de salvar nota, varra analogias em outros domínios.">${esc(ownerInstructions)}</textarea>
            <div class="row" style="margin-top:10px;gap:8px;align-items:center">
              <button type="submit" class="btn btn-primary">Salvar</button>
              <span id="owner-instructions-count" style="color:var(--text-dim);font-size:13px">${len}/${OWNER_INSTRUCTIONS_MAX_LEN}</span>
            </div>
          </form>
          <p style="color:var(--text-dim);font-size:13px;margin-top:8px">Aparece pra qualquer credencial válida (login OAuth ou chave de API) no início da sessão do agente — deixe em branco e salve pra remover.<br>Não são segredo e vão pro handshake em texto puro: <strong>nunca coloque senhas, tokens ou chaves aqui</strong>.</p>
        </div>
      </div>
    </details>`;
}

export async function handleConfigPrefsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const prompt = String(form.get('prompt') ?? '').trim();
  if (!prompt) return htmlResponse('Prompt não pode ficar vazio', 400);
  if (prompt.length > PREFS_MAX_LEN) {
    return htmlResponse(`Prompt longo demais (máx ${PREFS_MAX_LEN} caracteres)`, 400);
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(PREFS_META_KEY, prompt)
    .run();
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=prefs#prefs' } });
}

// POST /app/config/owner-instructions — "CLAUDE.md do Brain" (spec 50-console-v2/70).
// Sessão obrigatória (mesmo padrão de /app/config/prefs). Texto vazio REMOVE a
// chave `owner_instructions` (writeOwnerInstructions cuida do cap 4000 + sanitize).
export async function handleConfigOwnerInstructionsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const raw = String(form.get('owner_instructions') ?? '');
  await writeOwnerInstructions(env, raw);
  return new Response(null, {
    status: 302,
    headers: { location: '/app/config?saved=owner#owner-instructions' },
  });
}

export async function handleConfigPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const url = new URL(req.url);
  // M6 fix: a chave plaintext NÃO chega mais via query param. /app/api-keys/create
  // grava em KV com TTL curto e redireciona com um id opaco; aqui consumimos e
  // deletamos (single-use). Sem fallback pra ?new=: redirects em voo no momento
  // do deploy perdem a exibição da chave, mas o aluno só precisa recriar — bem
  // melhor do que continuar vazando a chave no histórico do browser.
  const flash = url.searchParams.get('flash');
  let justCreatedKey: string | null = null;
  if (flash && /^[a-f0-9]{32}$/.test(flash)) {
    const key = flashKvKey(flash);
    const value = await env.OAUTH_KV.get(key);
    if (value) {
      justCreatedKey = value;
      await env.OAUTH_KV.delete(key);
    }
  }

  // Após salvar o prompt, o POST redireciona com ?saved=prefs pra reabrir a aba
  // "Sistemas web" (que contém o prompt) já expandida.
  const savedPrefs = url.searchParams.get('saved') === 'prefs';
  // Idem pra gestão de colunas do Kanban (?saved=board reabre a seção "Quadro de tarefas").
  const savedBoard = url.searchParams.get('saved') === 'board';
  // Idem pra gestão de projetos (?saved=projects reabre a seção "Projetos").
  const savedProjects = url.searchParams.get('saved') === 'projects';
  // Idem pra taxonomia de áreas/kinds (?saved=taxonomy reabre "Áreas e tipos").
  const savedTaxonomy = url.searchParams.get('saved') === 'taxonomy';
  // Idem pra usuários/responsáveis (?saved=users reabre "Usuários" — spec 37).
  const savedUsers = url.searchParams.get('saved') === 'users';
  // Idem pras instruções do dono (?saved=owner reabre "Instruções pros agentes").
  const savedOwner = url.searchParams.get('saved') === 'owner';

  // Seção "Quadro de tarefas": colunas (ativas + arquivadas) + contagem de tasks.
  const [kanbanColumns, kanbanCounts] = await Promise.all([
    listKanbanColumns(env, true),
    taskCountsByColumn(env),
  ]);
  const boardSection = renderBoardSection(kanbanColumns, kanbanCounts, savedBoard);

  // Seção "Projetos": pastas (ativas + arquivadas) + contagem de tasks (spec 58).
  const [taskProjects, projectCounts] = await Promise.all([
    listTaskProjects(env, true),
    taskCountsByProject(env),
  ]);
  const projectsSection = renderProjectsSection(taskProjects, projectCounts, savedProjects);

  // Seção "Áreas e tipos" (spec 54): contagem por área (NON_TASK_FILTER) + config
  // customizada do dono (cor/label + áreas pré-criadas).
  const [domainCounts, taxonomyConfig] = await Promise.all([
    listDomainCounts(env),
    getTaxonomyConfig(env),
  ]);
  const taxonomySection = renderTaxonomySection(domainCounts, taxonomyConfig, savedTaxonomy);

  // Seção "Usuários" (spec 37): perfis de atribuição (pessoa/agente) + vínculo
  // com PAT. A lista de chaves alimenta o dropdown de vínculo — reusa a mesma
  // query da seção API Keys logo abaixo (o custo é uma leitura pequena a mais).
  const allUsers = await listUsers(env, true);

  const prefsPrompt = await getPersonalizationPrompt(env);
  // Seção "Instruções pros agentes (MCP)" (spec 70): valor cru da meta (vazio
  // quando a chave não existe) + estado do accordion.
  const ownerInstructions = (await readOwnerInstructions(env)) ?? '';
  const ownerInstructionsSection = renderOwnerInstructionsSection(ownerInstructions, savedOwner);
  const stats = await getVaultStatus(env);
  const lastWriteStr = stats.lastWrite
    ? new Date(stats.lastWrite).toLocaleString('pt-BR')
    : 'Nunca';

  // Seção Backup (spec 67): status do último snapshot lido de meta.last_backup
  // (gravado tanto pelo cron semanal quanto pelo "Fazer backup agora").
  const lastBackup = await readLastBackup(env);
  let backupStatus: string;
  if (!lastBackup) {
    backupStatus = `<p style="color:var(--text-dim)">Nenhum snapshot ainda. O backup automático roda toda segunda às 02:00 (BRT) — ou dispare um agora.</p>`;
  } else if (lastBackup.ok) {
    const nTables = Object.keys(lastBackup.tables).length;
    backupStatus = `<p><span class="badge-pill badge-ok">● OK</span> &nbsp;<strong>${esc(formatBrtDateTime(lastBackup.at))}</strong> &nbsp;·&nbsp; ${lastBackup.total_rows} linhas em ${nTables} tabelas &nbsp;·&nbsp; ${esc(formatBytes(lastBackup.bytes))} &nbsp;·&nbsp; <code>${esc(lastBackup.prefix)}</code></p>`;
  } else {
    backupStatus = `<p><span class="badge-pill badge-warn">○ Falhou</span> &nbsp;<strong>${esc(formatBrtDateTime(lastBackup.at))}</strong> &nbsp;·&nbsp; <span style="color:var(--text-dim)">${esc(lastBackup.error ?? 'erro desconhecido')}</span></p>`;
  }

  const badge = stats.connected
    ? `<span class="badge-pill badge-ok">● Claude conectado</span>`
    : `<span class="badge-pill badge-warn">○ Aguardando — conecte numa das opções abaixo</span>`;

  // API Keys — integrado dentro de Config (antes era page separada /app/api-keys).
  const keys = await listApiKeys(env, session.email);
  const usersSection = renderUsersSection(allUsers, keys, savedUsers, !!env.MEDIA);
  const keyRows = keys
    .map((k) => {
      const created = new Date(k.created_at).toLocaleString('pt-BR');
      const lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleString('pt-BR') : '—';
      const revoked = k.revoked_at !== null;
      // Revogação lógica (spec 17): a linha permanece como trilha de auditoria. Sem
      // botão Excluir numa chave já revogada (e não há "un-revoke").
      const statusBadge = revoked
        ? `<span class="badge-pill badge-warn">● revogada</span>`
        : `<span class="badge-pill badge-ok">● ativa</span>`;
      const revokeBtn = revoked
        ? '—'
        : `<form method="post" action="/app/api-keys/revoke" style="display:inline">
             <input type="hidden" name="id" value="${esc(k.id)}">
             <button type="submit" class="btn btn-danger btn-sm">Revogar</button>
           </form>`;
      // Escopo (spec 17 + 31): CSV — base full/read + escopo aditivo 'private'.
      // Mostra o CSV integral (ex.: 'full,private') pra o dono ver o alcance real.
      const scopeLabel = k.scopes && k.scopes.trim() ? k.scopes : 'full';
      return `<tr${revoked ? ' style="opacity:0.55"' : ''}>
        <td><strong>${esc(k.name)}</strong></td>
        <td><code>${esc(k.prefix)}…</code></td>
        <td><span class="badge-pill">${esc(scopeLabel)}</span></td>
        <td>${statusBadge}</td>
        <td>${esc(created)}</td>
        <td>${esc(lastUsed)}</td>
        <td>${revokeBtn}</td>
      </tr>`;
    })
    .join('');

  const createdBanner = justCreatedKey
    ? `<div class="key-flash">
         <h2>Chave criada — copie agora</h2>
         <p>Essa é a única vez que a chave completa aparece. Clique no campo pra selecionar tudo e Ctrl+C.</p>
         <input type="text" readonly class="key-flash-value" value="${esc(justCreatedKey)}">
       </div>`
    : '';

  // Aba ativa no primeiro paint (spec 69): os redirects ?saved= de board/projects/
  // taxonomy caem na aba "Organização" e o de backup na aba "Sistema"; todo o resto
  // (prefs, owner, chave criada) mora na aba padrão "Conexões". Deep links por hash
  // (#backup, #board...) são resolvidos no client — o servidor não vê o fragment.
  const savedBackup = url.searchParams.get('saved') === 'backup';
  const activeTab: 'conexoes' | 'organizacao' | 'sistema' =
    savedBoard || savedProjects || savedTaxonomy || savedUsers ? 'organizacao' : savedBackup ? 'sistema' : 'conexoes';
  const tabButton = (slug: string, label: string): string =>
    `<button type="button" role="tab" id="config-tab-${slug}" data-tab="${slug}" aria-controls="panel-${slug}" aria-selected="${activeTab === slug ? 'true' : 'false'}"${activeTab === slug ? '' : ' tabindex="-1"'}>${label}</button>`;

  const body = `
    <div class="page-header">
      <h1>Configurações ${badge}</h1>
    </div>

    <nav class="config-tabs" role="tablist" aria-label="Seções das configurações">
      ${tabButton('conexoes', 'Conexões')}
      ${tabButton('organizacao', 'Organização')}
      ${tabButton('sistema', 'Sistema')}
    </nav>
    <noscript><style>.config-panel{display:block !important}.config-tabs{display:none}</style></noscript>

    <section class="config-panel${activeTab === 'conexoes' ? ' active' : ''}" id="panel-conexoes" role="tabpanel" aria-labelledby="config-tab-conexoes" data-panel="conexoes">
    <p class="config-subtitle">Como você liga o Expert Brain aos seus clientes de IA — e as orientações que todo agente recebe ao conectar. Abra o caso que é o seu.</p>

    <details class="disclosure-advanced conn-section" open>
      <summary>
        <span class="adv-title">Agente no seu computador</span>
        <span class="adv-sub">Claude Code, Codex ou qualquer agente instalado na sua máquina — conecta por login, sem chave</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Esses clientes conectam direto na <strong>URL do servidor MCP</strong> e fazem login via OAuth. Cole a URL no cliente:</p>
          <div class="row">
            <div id="mcp-url" class="js-mcp-url url-box">/mcp</div>
            <button type="button" data-copy="mcp-url">Copiar URL</button>
          </div>
          <p class="callout-info">
            <strong>Não precisa de chave de API.</strong> Ao conectar, abre o navegador pedindo login — use o <em>mesmo e-mail e senha</em> deste painel. O token é guardado automaticamente pelo cliente (OAuth 2.1).
          </p>
        </div>
        <div class="adv-section">
          <h3>Claude Code (CLI)</h3>
          <p>No terminal, rode:</p>
          <div class="row">
            <div id="code-add" class="js-code-add url-box">claude mcp add --transport http expert-brain &lt;URL&gt;</div>
            <button type="button" data-copy="code-add">Copiar comando</button>
          </div>
          <p class="callout-info">
            <strong>Captura automática:</strong> só conectar o MCP deixa o Brain no modo <em>reativo</em> (salva quando você pede). O <code>npm run setup</code> da instalação também instala os hooks do Claude Code que fazem o Brain <em>salvar e lembrar sozinho</em>. Pra ligar numa outra máquina, rode na pasta do projeto: <code>node scripts/install-claude-hooks.mjs &lt;URL do Worker&gt;</code>.
          </p>
        </div>
      </div>
    </details>

    <details class="disclosure-advanced conn-section" id="prefs"${savedPrefs ? ' open' : ''}>
      <summary>
        <span class="adv-title">Sistemas web</span>
        <span class="adv-sub">ChatGPT (modo desenvolvedor) ou Claude.ai — conector MCP no navegador</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>No Claude.ai ou no ChatGPT (modo desenvolvedor), adicione um <strong>conector MCP personalizado</strong> e cole esta URL. A conexão também é por login (OAuth), sem chave.</p>
          <div class="row">
            <div id="mcp-url-web" class="js-mcp-url url-box">/mcp</div>
            <button type="button" data-copy="mcp-url-web">Copiar URL</button>
          </div>
        </div>
        <div class="adv-section">
          <h3>Prompt de personalização</h3>
          <p>Cole este texto nas <em>instruções</em> do cliente (Claude.ai → <strong>Configurações → Geral → Instruções para o Claude</strong>; ChatGPT → instruções do projeto) pra ele usar o vault sozinho em toda conversa, não só quando o tema é óbvio. Edite com seu nome e suas áreas e clique <strong>Salvar</strong>.</p>
          <form method="post" action="/app/config/prefs">
            <textarea id="prefs-block" name="prompt" rows="14" maxlength="${PREFS_MAX_LEN}" class="prefs-textarea">${esc(prefsPrompt)}</textarea>
            <div class="row" style="margin-top:10px;gap:8px">
              <button type="submit" class="btn btn-primary">Salvar</button>
              <button type="button" data-copy="prefs-block">Copiar prompt</button>
            </div>
          </form>
        </div>
      </div>
    </details>

    <details class="disclosure-advanced conn-section" id="api-keys"${justCreatedKey ? ' open' : ''}>
      <summary>
        <span class="adv-title">Agentes externos e automações</span>
        <span class="adv-sub">OpenClaw ou sistemas rodando numa VPS — precisam de uma chave de API (token)</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Agentes que rodam fora da sua máquina (ex: OpenClaw, scripts e containers numa VPS) não conseguem fazer o login OAuth no navegador. Pra esses, crie uma <strong>chave de API</strong> e envie no header <code>Authorization: Bearer eb_pat_...</code> em <code>/mcp</code>. As chaves não expiram — revogue pra matar o acesso na hora.</p>
        </div>
        ${createdBanner}
        <div class="adv-section">
          <h3>Criar nova chave</h3>
          <form method="post" action="/app/api-keys/create">
            <label>Nome (pra você lembrar onde usa)
              <input type="text" name="name" required maxlength="80" placeholder="hermes-vps / openclaw-asafe / ..." class="input-text">
            </label>
            <label style="display:block;margin-top:12px">Escopo
              <select name="scope" class="input-text" style="display:block;margin-top:4px">
                <option value="full">Leitura e escrita — CRUD completo do vault</option>
                <option value="read">Somente leitura — recall, get, stats, list</option>
              </select>
            </label>
            <label style="display:flex;align-items:center;gap:8px;margin-top:12px">
              <input type="checkbox" name="private_scope" value="1">
              <span>Acesso a notas privadas <span style="color:var(--text-dim)">— sem isto, a chave NÃO vê notas marcadas como privadas (spec 31)</span></span>
            </label>
            <button type="submit" class="btn btn-primary" style="margin-top:12px">Criar chave</button>
          </form>
        </div>
        <div class="adv-section">
          <h3>Suas chaves</h3>
          ${keys.length === 0 ? '<p style="color:var(--text-dim)">Nenhuma chave ainda.</p>' : `
          <table class="keys-table">
            <thead><tr>
              <th>Nome</th><th>Prefixo</th><th>Escopo</th><th>Status</th><th>Criada em</th><th>Último uso</th><th></th>
            </tr></thead>
            <tbody>${keyRows}</tbody>
          </table>`}
        </div>
      </div>
    </details>

    <details class="disclosure-advanced conn-section" id="google-contatos">
      <summary>
        <span class="adv-title">Google Contatos</span>
        <span class="adv-sub">Sincroniza etiquetas escolhidas da sua agenda pro vault de contatos — mão única, o Google nunca é alterado</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Só entram os contatos das <strong>etiquetas que você escolher</strong> (nunca a agenda inteira). Nome, telefone, e-mail e aniversário vêm do Google; empresa e cargo só preenchem quando estão vazios aqui; observações e categorias locais nunca são tocadas. Apagar no Google <strong>não</strong> apaga o contato do vault. Roda sozinho 1x por dia.</p>
          <p id="gc-flash" class="callout-info" hidden></p>
          <p id="gc-status" style="color:var(--text-dim)">Carregando estado da conexão…</p>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" id="gc-connect" hidden>Conectar ao Google</button>
            <button type="button" class="btn" id="gc-sync" hidden>Sincronizar agora</button>
            <button type="button" class="btn" id="gc-disconnect" hidden>Desconectar</button>
          </div>
        </div>
        <div class="adv-section" id="gc-labels-section" hidden>
          <h3>Etiquetas sincronizadas</h3>
          <div id="gc-labels" style="display:flex;flex-direction:column;gap:6px"></div>
          <div class="row" style="margin-top:10px;gap:8px;align-items:center">
            <button type="button" class="btn btn-primary" id="gc-save-labels">Salvar etiquetas</button>
            <span id="gc-labels-status" style="color:var(--text-dim)"></span>
          </div>
        </div>
      </div>
    </details>

    <details class="disclosure-advanced conn-section" id="whatsapp-grupos">
      <summary>
        <span class="adv-title">Grupos do WhatsApp</span>
        <span class="adv-sub">Integração opcional com o WhatsApp Agent — grupos escolhidos viram nós no grafo de contatos, com quem está dentro</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Requer o <strong>WhatsApp Agent conectado</strong> — é ele quem fornece a lista de grupos e participantes; sem essa conexão este módulo não funciona. Só entram os <strong>grupos que você marcar</strong> abaixo (por padrão todos vêm marcados; desmarque o que não quiser). Participante só vira vínculo se <strong>já existe</strong> como contato no vault (match por telefone) — número desconhecido não cria contato novo. Quem sai do grupo perde o vínculo criado pelo sync; vínculos manuais ficam. A lista de grupos e os membros são empurrados por um script na sua máquina (peça ao Claude: "sincroniza os grupos do WhatsApp pro grafo").</p>
          <p id="wa-status" style="color:var(--text-dim)">Carregando estado da integração…</p>
        </div>
        <div class="adv-section" id="wa-create-section" hidden>
          <h3>Membros de grupo viram contatos</h3>
          <p style="margin-top:0">Desligado (padrão), participante desconhecido de grupo marcado <strong>não</strong> vira contato — só aparece como contador. Ligado, cada membro desconhecido dos grupos marcados <strong>vira um contato novo</strong> no vault (nome do WhatsApp + telefone) já vinculado ao grupo. Grupos grandes criam muitos contatos de uma vez — ligue só se quiser o grupo inteiro no grafo.</p>
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="wa-create-members">
            <span>Criar contato pra membro desconhecido dos grupos marcados</span>
          </label>
          <p id="wa-create-status" style="color:var(--text-dim);margin-bottom:0"></p>
        </div>
        <div class="adv-section" id="wa-groups-section" hidden>
          <h3>Grupos sincronizados</h3>
          <div class="row" style="gap:8px;margin-bottom:8px">
            <button type="button" class="btn" id="wa-select-all">Marcar todos</button>
            <button type="button" class="btn" id="wa-clear-all">Desmarcar todos</button>
          </div>
          <div id="wa-groups" style="display:flex;flex-direction:column;gap:6px"></div>
          <div class="row" style="margin-top:10px;gap:8px;align-items:center">
            <button type="button" class="btn btn-primary" id="wa-save-groups">Salvar grupos</button>
            <span id="wa-groups-status" style="color:var(--text-dim)"></span>
          </div>
        </div>
      </div>
    </details>

    <details class="disclosure-advanced conn-section" id="instagram-contatos">
      <summary>
        <span class="adv-title">Conversas do Instagram</span>
        <span class="adv-sub">Integração opcional com o Instagram Agent — conversas escolhidas viram contatos no grafo</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Requer o <strong>Instagram Agent conectado</strong> — é ele quem fornece a lista de conversas; sem essa conexão este módulo não funciona. Só entram as <strong>conversas que você marcar</strong> abaixo (por padrão todas vêm marcadas; desmarque o que não quiser). Marcar a conversa <strong>cria o contato</strong> se a pessoa ainda não existe no vault (com o @ do Instagram e o telefone, quando conhecido); se já existe, só ganha o vínculo e o canal — nome e dados locais nunca são sobrescritos. A lista de conversas é empurrada por um script na sua máquina (peça ao Claude: "sincroniza as conversas do Instagram pro grafo").</p>
          <p id="ig-status" style="color:var(--text-dim)">Carregando estado da integração…</p>
        </div>
        <div class="adv-section" id="ig-contacts-section" hidden>
          <h3>Conversas sincronizadas</h3>
          <div class="row" style="gap:8px;margin-bottom:8px">
            <button type="button" class="btn" id="ig-select-all">Marcar todas</button>
            <button type="button" class="btn" id="ig-clear-all">Desmarcar todas</button>
          </div>
          <div id="ig-contacts" style="display:flex;flex-direction:column;gap:6px"></div>
          <div class="row" style="margin-top:10px;gap:8px;align-items:center">
            <button type="button" class="btn btn-primary" id="ig-save-contacts">Salvar conversas</button>
            <span id="ig-contacts-status" style="color:var(--text-dim)"></span>
          </div>
        </div>
      </div>
    </details>

    <details class="disclosure-advanced conn-section" id="pipedrive-crm">
      <summary>
        <span class="adv-title">Pipedrive (CRM)</span>
        <span class="adv-sub">Integração opcional — enriquece contatos existentes com dados do seu CRM, mão única</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Integração <strong>opcional</strong>: só funciona se você conectar explicitamente o seu Pipedrive (chave de API no servidor de contatos). Quando ligada, roda 1x por dia e <strong>só preenche campos vazios</strong> (e-mail, empresa) de contatos que <strong>já existem</strong> no vault — nunca cria contato, nunca sobrescreve o que você editou, nunca escreve de volta no Pipedrive. Desligada, nada acontece.</p>
          <p id="pd-status" style="color:var(--text-dim)">Carregando estado da integração…</p>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <button type="button" class="btn" id="pd-sync" hidden>Sincronizar agora</button>
            <span id="pd-sync-status" style="color:var(--text-dim)"></span>
          </div>
        </div>
      </div>
    </details>

    ${ownerInstructionsSection}
    </section>

    <section class="config-panel${activeTab === 'organizacao' ? ' active' : ''}" id="panel-organizacao" role="tabpanel" aria-labelledby="config-tab-organizacao" data-panel="organizacao">
    <p class="config-subtitle">Como o seu conteúdo se organiza: colunas do quadro de tarefas, pastas de projeto e as áreas e tipos do vault.</p>

    ${boardSection}

    ${projectsSection}

    ${usersSection}

    ${taxonomySection}
    </section>

    <section class="config-panel${activeTab === 'sistema' ? ' active' : ''}" id="panel-sistema" role="tabpanel" aria-labelledby="config-tab-sistema" data-panel="sistema">
    <p class="config-subtitle">Saúde da instância: números do vault, snapshot semanal e export completo.</p>

    <div class="card">
      <h2>Status do vault</h2>
      <p><strong>Notas:</strong> ${stats.notes} &nbsp;·&nbsp; <strong>Conexões:</strong> ${stats.edges} &nbsp;·&nbsp; <strong>Última escrita:</strong> ${esc(lastWriteStr)}</p>
      <p style="color:var(--text-dim);font-size:13px"><strong>Clientes OAuth registrados:</strong> ${stats.clients} &nbsp;·&nbsp; <strong>Tokens ativos:</strong> ${stats.tokens}</p>
    </div>

    <div class="card" id="backup">
      <h2>Backup</h2>
      ${backupStatus}
      <div class="row" style="gap:8px;margin-top:10px">
        <form method="post" action="/app/config/backup-now">
          <button type="submit" class="btn btn-primary">Fazer backup agora</button>
        </form>
        <form method="get" action="/app/export">
          <button type="submit">Baixar export (.zip)</button>
        </form>
      </div>
      <p style="color:var(--text-dim);font-size:13px;margin-top:10px">O snapshot semanal (segunda, 02:00 BRT) grava um JSONL por tabela no R2 da instância (prefixo <code>backups/</code>, últimos 8 mantidos). O export baixa o MESMO conteúdo em ZIP — <strong>contém TUDO, inclusive notas privadas</strong>: guarde num lugar seguro. Restore é operação manual: <code>docs/restore.md</code>.</p>
    </div>
    </section>

    <script src="/app/config/bundle.js?v=${assetVersion('config.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({ title: 'Configurações', active: 'config', email: session.email, env, body, extraHead: `<style>${USERS_SECTION_CSS}</style>`, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}

// configPageScript foi extraída pra src/web/config-script.ts (módulo folha, sem
// deps de runtime) pra o build-bundles poder hasheá-la. Re-exportada aqui pra não
// quebrar os callers existentes (handler.ts). Ver spec 28.
export { configPageScript } from './config-script.js';
