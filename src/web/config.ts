import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { getVaultStatus } from '../auth/setup.js';
import { listApiKeys } from '../auth/api-keys.js';
import { flashKvKey } from './api-keys.js';
import { pshareFlashKey, listProjectShares, type ProjectShareRow } from './project-share.js';
import { readPersonalizationPrompt, readOwnerInstructions, writeOwnerInstructions, OWNER_INSTRUCTIONS_MAX_LEN } from '../db/meta.js';
import { assetVersion } from './asset-version.js';
import { readLastBackup } from '../backup/snapshot.js';
import { formatBrtDateTime } from '../util/time.js';
import { TASK_STATUSES, type TaskStatus, type KanbanColumn, listKanbanColumns, taskCountsByColumn, type TaskProject, TASK_PROJECT_CAP, listTaskProjects, taskCountsByProject, KNOWLEDGE_KINDS, listDomainCounts } from '../db/queries.js';
import { resolveDomainMeta, resolveKindMeta, DOMAIN_FALLBACK } from './domain-colors.js';
import { getTaxonomyConfig, mergedDomainSlugs } from './taxonomy-config.js';
import { listUsers } from '../db/queries.js';
import { listAllTags, type TagUsage } from '../db/tag-admin.js';
import { renderUsersSection, USERS_SECTION_CSS } from './users.js';
import { connCardSummary, ICON_GOOGLE, ICON_WHATSAPP, ICON_INSTAGRAM, ICON_FUNNEL } from './config-icons.js';

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
  // Swatch precisa de um #rrggbb válido pro <input type="color"> (não aceita
  // vazio) — usa o mesmo neutro de fallback das Áreas/Tipos (DOMAIN_FALLBACK)
  // quando a coluna não tem cor própria (ui-audit item CF1: antes era um input de
  // texto vazio, sem a cor atual pré-preenchida).
  const swatchVal = colorVal || DOMAIN_FALLBACK;
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
        <span style="display:inline-flex;align-items:center;gap:6px">
          <input type="color" name="color" value="${esc(swatchVal)}" class="tax-swatch" aria-label="Cor da coluna ${esc(col.label)}">
          <code style="font-size:11px;color:var(--text-dim)">${colorVal ? esc(colorVal) : 'sem cor'}</code>
        </span>
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

function renderProjectsSection(
  projects: TaskProject[],
  counts: Map<string, number>,
  savedProjects: boolean,
  shares: ProjectShareRow[] = [],
  justCreatedShareUrl: string | null = null
): string {
  const total = projects.length;
  const rows = projects.length
    ? projects.map((p) => renderProjectRow(p, counts.get(p.id) ?? 0)).join('')
    : `<tr><td colspan="4" style="color:var(--text-dim)">Nenhum projeto ainda. Crie um abaixo, ou deixe a task sem projeto (o padrão).</td></tr>`;
  const atCap = total >= TASK_PROJECT_CAP;

  // Shares públicos por projeto (spec 85). A URL /p/ plaintext só aparece no banner
  // one-time (pflash); a listagem identifica pelo prefixo. Revogados ficam fora da
  // tabela (revogação é terminal — sem un-revoke, o histórico vive no banco).
  const projectLabelById = new Map(projects.map((p) => [p.id, p.label] as const));
  const activeShares = shares.filter((s) => s.revoked_at === null);
  const now = Date.now();
  const shareRows = activeShares.map((s) => {
    const expired = s.expires_at != null && s.expires_at <= now;
    return `<tr${expired ? ' style="opacity:0.55"' : ''}>
      <td>${esc(projectLabelById.get(s.project_id) ?? s.project_id)}</td>
      <td><strong>${esc(s.label)}</strong></td>
      <td>${s.mode === 'comment' ? 'leitura + comentários' : 'somente leitura'}</td>
      <td><code>${esc(s.prefix)}…</code></td>
      <td>${s.expires_at != null ? `${esc(formatBrtDateTime(s.expires_at))}${expired ? ' (expirado)' : ''}` : 'sem expiração'}</td>
      <td><form method="post" action="/app/project-shares/revoke" style="display:inline">
        <input type="hidden" name="id" value="${esc(s.id)}">
        <button type="submit" class="btn btn-danger btn-sm">Revogar</button>
      </form></td>
    </tr>`;
  }).join('');
  const shareBanner = justCreatedShareUrl
    ? `<div class="key-flash" id="pshare-flash">
         <h2>Link do board criado — copie agora</h2>
         <p>Essa é a única vez que a URL completa aparece. Quem tiver o link vê o recorte do projeto — trate como convite.</p>
         <div class="row" style="gap:8px">
           <input type="text" readonly id="pshare-flash-value" class="key-flash-value" value="${esc(justCreatedShareUrl)}">
           <button type="button" data-copy="pshare-flash-value">Copiar</button>
         </div>
       </div>`
    : '';
  const activeProjects = projects.filter((p) => p.archived_at === null);
  const sharesBlock = `
        <div class="adv-section">
          <h3>Board compartilhado (link externo)</h3>
          <p>Compartilha <strong>só as tasks de um projeto</strong> (nunca as privadas, nunca notas/grafo) com alguém de fora, por link <code>/p/…</code>. Modo <em>comentários</em>: quem tem o link comenta assinando a identidade abaixo, com selo EXTERNO — e os responsáveis recebem no mailbox. Revogar mata o link na hora.</p>
          ${shareBanner}
          ${activeShares.length === 0 ? '' : `
          <table class="keys-table">
            <thead><tr><th>Projeto</th><th>Identidade externa</th><th>Permissão</th><th>Link</th><th>Expira</th><th></th></tr></thead>
            <tbody>${shareRows}</tbody>
          </table>`}
          ${activeProjects.length === 0 ? '' : `
          <form method="post" action="/app/project-shares/create" class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
            <select name="project_id" required class="input-text" aria-label="Projeto">
              ${activeProjects.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}
            </select>
            <input type="text" name="label" required maxlength="60" placeholder="Identidade externa (ex: Cliente X)" class="input-text" style="width:220px">
            <select name="mode" class="input-text" aria-label="Permissão">
              <option value="read">Somente leitura</option>
              <option value="comment">Leitura + comentários</option>
            </select>
            <input type="number" name="expires_days" min="1" max="365" placeholder="Expira em (dias, opcional)" class="input-text" style="width:190px">
            <button type="submit" class="btn btn-primary">Criar link</button>
          </form>`}
        </div>`;
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
        ${sharesBlock}
      </div>
    </details>`;
}

// ─────────────── Seção "Tags" (gestão global — pedido 10/07) ───────────────
// Tags são vocabulário aberto (nascem na edição de nota/task, sem cadastro);
// aqui é só curadoria: renomear em massa (merge-safe) e apagar. A lista vem de
// db/tag-admin.ts (exclui dedupe:* e notas soft-deletadas).
function renderTagRow(t: TagUsage): string {
  return `<tr data-tag-row="${esc(t.tag)}">
    <td>
      <form method="post" action="/app/tasks/tags/rename" class="row" style="gap:6px;align-items:center">
        <input type="hidden" name="from" value="${esc(t.tag)}">
        <input type="text" name="to" value="${esc(t.tag)}" maxlength="60" class="input-text" style="width:200px" aria-label="Novo nome pra tag ${esc(t.tag)}">
        <button type="submit">Renomear</button>
      </form>
    </td>
    <td>${t.count}</td>
    <td>
      <form method="post" action="/app/tasks/tags/delete" class="tag-delete-form" style="display:inline" data-tag="${esc(t.tag)}">
        <input type="hidden" name="tag" value="${esc(t.tag)}">
        <button type="submit" class="btn btn-danger btn-sm">Apagar</button>
      </form>
    </td>
  </tr>`;
}

function renderTagsSection(tags: TagUsage[], savedTags: boolean): string {
  const rows = tags.length
    ? tags.map(renderTagRow).join('')
    : `<tr><td colspan="3" style="color:var(--text-dim)">Nenhuma tag ainda. Tags nascem na edição de notas e tasks — não há cadastro prévio.</td></tr>`;
  return `
    <details class="disclosure-advanced conn-section" id="tags"${savedTags ? ' open' : ''}>
      <summary>
        <span class="adv-title">Tags</span>
        <span class="adv-sub">Vocabulário de rótulos — renomeie em massa ou apague (${tags.length} tag${tags.length === 1 ? '' : 's'})</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Tag é rótulo <strong>transversal e multi</strong> (diferente de projeto, que é pasta). Renomear aplica em <strong>todas</strong> as notas e tasks de uma vez — se o novo nome já existe, as duas tags se fundem. Apagar remove o rótulo das notas, <strong>não</strong> apaga as notas.</p>
          <input type="search" id="tags-filter" class="input-text" placeholder="Filtrar tags…" aria-label="Filtrar tags" style="width:240px;margin-bottom:10px" autocomplete="off">
          <table class="keys-table">
            <thead><tr><th>Tag (renomear e Enter)</th><th>Usos</th><th></th></tr></thead>
            <tbody id="tags-tbody">${rows}</tbody>
          </table>
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
  // Mesmo padrão pro share de board por projeto (spec 85): a URL /p/<token> só
  // aparece uma vez, via ?pflash= consumido do KV (single-use).
  const pflash = url.searchParams.get('pflash');
  let justCreatedShareUrl: string | null = null;
  if (pflash && /^[a-f0-9]{32}$/.test(pflash)) {
    const key = pshareFlashKey(pflash);
    const value = await env.OAUTH_KV.get(key);
    if (value) {
      justCreatedShareUrl = value;
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
  // Idem pra gestão de tags (?saved=tags reabre "Tags").
  const savedTags = url.searchParams.get('saved') === 'tags';
  // Idem pra usuários/responsáveis (?saved=users reabre "Usuários" — spec 37).
  const savedUsers = url.searchParams.get('saved') === 'users';
  // Idem pras instruções do dono (?saved=owner reabre "Instruções pros agentes").
  const savedOwner = url.searchParams.get('saved') === 'owner';

  // As 12 leituras abaixo (Quadro de tarefas, Projetos, Áreas e tipos, Usuários,
  // API Keys, prompt de personalização, Instruções pros agentes, Status do vault
  // e Backup) não dependem umas das outras — paralelizadas num único Promise.all
  // em vez dos ~9 awaits sequenciais de antes (cada seção esperando a anterior
  // terminar pra só então disparar a query seguinte).
  const [
    kanbanColumns,
    kanbanCounts,
    taskProjects,
    projectCounts,
    allTags,
    domainCounts,
    taxonomyConfig,
    allUsers,
    keys,
    prefsPrompt,
    ownerInstructionsRaw,
    stats,
    lastBackup,
    projectShares,
  ] = await Promise.all([
    listKanbanColumns(env, true),
    taskCountsByColumn(env),
    listTaskProjects(env, true),
    taskCountsByProject(env),
    listAllTags(env),
    listDomainCounts(env),
    getTaxonomyConfig(env),
    listUsers(env, true),
    listApiKeys(env, session.email),
    getPersonalizationPrompt(env),
    readOwnerInstructions(env),
    getVaultStatus(env),
    readLastBackup(env),
    listProjectShares(env),
  ]);

  // Seção "Quadro de tarefas": colunas (ativas + arquivadas) + contagem de tasks.
  const boardSection = renderBoardSection(kanbanColumns, kanbanCounts, savedBoard);

  // Seção "Projetos": pastas (ativas + arquivadas) + contagem de tasks (spec 58) +
  // shares públicos por projeto (spec 85; abre a seção quando um share acabou de nascer).
  const projectsSection = renderProjectsSection(
    taskProjects, projectCounts, savedProjects || justCreatedShareUrl !== null,
    projectShares, justCreatedShareUrl
  );

  // Seção "Tags": vocabulário global com renomear/apagar (pedido 10/07).
  const tagsSection = renderTagsSection(allTags, savedTags);

  // Seção "Áreas e tipos" (spec 54): contagem por área (NON_TASK_FILTER) + config
  // customizada do dono (cor/label + áreas pré-criadas).
  const taxonomySection = renderTaxonomySection(domainCounts, taxonomyConfig, savedTaxonomy);

  // Seção "Usuários" (spec 37): perfis de atribuição (pessoa/agente) + vínculo
  // com PAT. A lista de chaves alimenta o dropdown de vínculo — reusa a mesma
  // leitura da seção API Keys logo abaixo (o custo é uma leitura pequena a mais).
  const usersSection = renderUsersSection(allUsers, keys, savedUsers, !!env.MEDIA);

  // Seção "Instruções pros agentes (MCP)" (spec 70): valor cru da meta (vazio
  // quando a chave não existe) + estado do accordion.
  const ownerInstructions = ownerInstructionsRaw ?? '';
  const ownerInstructionsSection = renderOwnerInstructionsSection(ownerInstructions, savedOwner);
  const lastWriteStr = stats.lastWrite
    ? new Date(stats.lastWrite).toLocaleString('pt-BR')
    : 'Nunca';

  // Seção Backup (spec 67): status do último snapshot lido de meta.last_backup
  // (gravado tanto pelo cron semanal quanto pelo "Fazer backup agora").
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
  // (leitura já feita no Promise.all acima, junto com usersSection.)
  // Listagem AGRUPADA por sistema (spec 87): a tela plana escondia qual chave vive
  // onde — o bug do PC assinando como Claude VPS ficou invisível nela. Agora: grupos
  // por `system` (frota primeiro), coluna Dono (identidade de assinatura), último uso
  // relativo com selo "dormindo" (30+ dias sem uso = candidata a revogação) e as
  // revogadas colapsadas num details próprio (trilha de auditoria, não poluição).
  const userNameById = new Map(allUsers.map((u) => [u.id, u.name] as const));
  const DORMANT_MS = 30 * 24 * 3600_000;
  const relUse = (ms: number): string => {
    const h = Math.floor((Date.now() - ms) / 3600_000);
    if (h < 1) return 'há menos de 1h';
    if (h < 48) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  };
  // Chave órfã ATIVA ganha o form de vincular dono inline (adendo spec 87): antes o
  // "sem dono" era só um selo sem saída — as chaves emitidas antes da 0021 não tinham
  // como ganhar dono pela UI. Orphan-only: chave com dono não expõe edição (trocar
  // identidade de agente vivo = revogar e criar outra).
  const ownerOptions = allUsers
    .filter((u) => u.archived_at === null)
    .map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`)
    .join('');
  const keyRow = (k: (typeof keys)[number], revoked: boolean): string => {
    const ownerName = k.user_id ? (userNameById.get(k.user_id) ?? k.user_id) : null;
    const ownerCell = ownerName
      ? esc(ownerName)
      : revoked
        ? `<span class="badge-pill badge-warn">sem dono</span>`
        : `<form method="post" action="/app/api-keys/owner" style="display:inline-flex;gap:6px;align-items:center">
             <input type="hidden" name="id" value="${esc(k.id)}">
             <select name="user_id" required><option value="">sem dono — vincular…</option>${ownerOptions}</select>
             <button type="submit" class="btn btn-sm">Vincular</button>
           </form>`;
    const lastRef = k.last_used_at ?? k.created_at;
    const dormant = !revoked && Date.now() - lastRef > DORMANT_MS;
    const lastUsed = k.last_used_at ? esc(relUse(k.last_used_at)) : 'nunca';
    const scopeLabel = k.scopes && k.scopes.trim() ? k.scopes : 'full';
    const revokeBtn = revoked
      ? '—'
      : `<form method="post" action="/app/api-keys/revoke" style="display:inline">
           <input type="hidden" name="id" value="${esc(k.id)}">
           <button type="submit" class="btn btn-danger btn-sm">Revogar</button>
         </form>`;
    return `<tr${revoked ? ' style="opacity:0.55"' : ''}>
      <td><strong>${esc(k.name)}</strong>${dormant ? ' <span class="badge-pill badge-warn" title="Sem uso há 30+ dias — se a máquina morreu, revogue">dormindo</span>' : ''}</td>
      <td><code>${esc(k.prefix)}…</code></td>
      <td>${ownerCell}</td>
      <td><span class="badge-pill">${esc(scopeLabel)}</span></td>
      <td>${lastUsed}</td>
      <td>${revokeBtn}</td>
    </tr>`;
  };
  const keysTableHead = `<thead><tr><th>Nome</th><th>Prefixo</th><th>Dono</th><th>Escopo</th><th>Último uso</th><th></th></tr></thead>`;
  const activeKeys = keys.filter((k) => k.revoked_at === null);
  const revokedKeys = keys.filter((k) => k.revoked_at !== null);
  const groupOf = (k: (typeof keys)[number]): string => (k.system ?? '').trim();
  const groupNames = [...new Set(activeKeys.map(groupOf))].sort((a, b) => {
    // 'frota' sempre primeiro (é o grupo operacional do barramento); vazio (sem
    // sistema) sempre por último; o resto alfabético.
    if (a === b) return 0;
    if (a === 'frota') return -1;
    if (b === 'frota') return 1;
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b, 'pt-BR');
  });
  const keyGroups = groupNames
    .map((g) => {
      const rows = activeKeys.filter((k) => groupOf(k) === g).map((k) => keyRow(k, false)).join('');
      return `<div class="key-group" data-key-group="${esc(g)}">
        <h4 style="margin:14px 0 6px">${g ? esc(g) : 'Sem sistema'}</h4>
        <table class="keys-table">${keysTableHead}<tbody>${rows}</tbody></table>
      </div>`;
    })
    .join('');
  const revokedBlock = revokedKeys.length === 0
    ? ''
    : `<details id="keys-revoked" style="margin-top:14px">
        <summary style="cursor:pointer;color:var(--text-dim)">Revogadas (${revokedKeys.length}) — trilha de auditoria</summary>
        <table class="keys-table" style="margin-top:8px">${keysTableHead}<tbody>${revokedKeys.map((k) => keyRow(k, true)).join('')}</tbody></table>
      </details>`;
  const keysListing = keys.length === 0
    ? '<p style="color:var(--text-dim)">Nenhuma chave ainda.</p>'
    : `${keyGroups}${revokedBlock}`;
  // Datalist do campo Sistema: os valores já usados + 'frota' como semente.
  const knownSystems = [...new Set(['frota', ...keys.map((k) => (k.system ?? '').trim()).filter(Boolean)])];

  // Banner one-time (spec 87): a chave plaintext aparece UMA vez e o fechamento é um
  // ato consciente — botão "Já salvei no 1Password" (JS em config-script.ts pede
  // confirm se fechar sem ter copiado). Sem X, sem fechar clicando fora.
  const createdBanner = justCreatedKey
    ? `<div class="key-flash" id="key-flash">
         <h2>Chave criada — copie AGORA</h2>
         <p>Essa é a <strong>única vez</strong> que a chave completa aparece — não dá pra recuperar depois, só criar outra. Copie e guarde no seu gerenciador de senhas.</p>
         <div class="row" style="gap:8px">
           <input type="text" readonly id="key-flash-value" class="key-flash-value" value="${esc(justCreatedKey)}">
           <button type="button" id="key-flash-copy" data-copy="key-flash-value">Copiar</button>
         </div>
         <button type="button" class="btn btn-primary" id="key-flash-ack" style="margin-top:10px">Já salvei no 1Password</button>
       </div>`
    : '';

  // Aba ativa no primeiro paint (spec 69, redesign 11/07): os redirects ?saved= de
  // board/projects/taxonomy/tags caem na aba "Organização" e o de backup na aba
  // "Sistema"; todo o resto (prefs, owner, users, chave criada) mora na aba padrão
  // "Agentes". Deep links por hash (#backup, #board...) são resolvidos no client —
  // o servidor não vê o fragment (o alias #conexoes → agentes também vive lá).
  const savedBackup = url.searchParams.get('saved') === 'backup';
  const activeTab: 'agentes' | 'integracoes' | 'organizacao' | 'sistema' =
    savedBoard || savedProjects || savedTaxonomy || savedTags || justCreatedShareUrl !== null
      ? 'organizacao' : savedBackup ? 'sistema' : 'agentes';
  const tabButton = (slug: string, label: string): string =>
    `<button type="button" role="tab" id="config-tab-${slug}" data-tab="${slug}" aria-controls="panel-${slug}" aria-selected="${activeTab === slug ? 'true' : 'false'}"${activeTab === slug ? '' : ' tabindex="-1"'}>${label}</button>`;

  const body = `
    <div class="page-header">
      <h1>Configurações ${badge}</h1>
    </div>

    <nav class="config-tabs" role="tablist" aria-label="Seções das configurações">
      ${tabButton('agentes', 'Agentes')}
      ${tabButton('integracoes', 'Integrações')}
      ${tabButton('organizacao', 'Organização')}
      ${tabButton('sistema', 'Sistema')}
    </nav>
    <noscript><style>.config-panel{display:block !important}.config-tabs{display:none}</style></noscript>

    <section class="config-panel${activeTab === 'agentes' ? ' active' : ''}" id="panel-agentes" role="tabpanel" aria-labelledby="config-tab-agentes" data-panel="agentes">
    <p class="config-subtitle">Quem conecta no Brain: perfis de pessoas e agentes, chaves de API e as orientações que todo agente recebe ao conectar.</p>

    ${usersSection}

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
            <label style="display:block;margin-top:12px">Sistema <span style="color:var(--text-dim)">— agrupa a listagem (opcional): frota, hermes, openclaw...</span>
              <input type="text" name="system" maxlength="40" list="key-systems" placeholder="frota" class="input-text" style="display:block;margin-top:4px">
            </label>
            <datalist id="key-systems">${knownSystems.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
            <label style="display:block;margin-top:12px">Dono da chave (spec 86 — a credencial ASSINA como este usuário)
              <select name="user_id" required class="input-text" style="display:block;margin-top:4px">
                <option value="">— escolha o usuário —</option>
                ${allUsers.filter((u) => u.archived_at === null).map((u) => `<option value="${esc(u.id)}">${esc(u.name)} (${u.type === 'agent' ? 'agente' : 'pessoa'})</option>`).join('')}
              </select>
            </label>
            <label style="display:block;margin-top:12px">Escopo
              <select name="scope" class="input-text" style="display:block;margin-top:4px">
                <option value="full">Leitura e escrita — CRUD completo do vault</option>
                <option value="read">Somente leitura — recall, get, stats, list</option>
              </select>
            </label>
            <label style="display:flex;align-items:center;gap:8px;margin-top:12px">
              <input type="checkbox" name="private_scope" value="1">
              <span>Acesso a notas privadas <span style="color:var(--text-dim)">— capacidade sensível: prefira uma chave SEPARADA só pra isso, em vez de dar acesso privado à chave do dia a dia (spec 86 §4). Sem isto, a chave não vê notas privadas.</span></span>
            </label>
            <button type="submit" class="btn btn-primary" style="margin-top:12px">Criar chave</button>
          </form>
        </div>
        <div class="adv-section">
          <h3>Suas chaves</h3>
          ${keysListing}
        </div>
      </div>
    </details>

    ${ownerInstructionsSection}
    </section>

    <section class="config-panel${activeTab === 'integracoes' ? ' active' : ''}" id="panel-integracoes" role="tabpanel" aria-labelledby="config-tab-integracoes" data-panel="integracoes">
    <p class="config-subtitle">Fontes externas que alimentam o vault de contatos. Cada card mostra o estado atual — clique pra configurar.</p>

    <div class="config-cards">

    <details class="disclosure-advanced conn-section conn-card" id="google-contatos">
      ${connCardSummary({
        icon: ICON_GOOGLE,
        title: 'Google Contatos',
        sub: 'Sincroniza etiquetas escolhidas da sua agenda pro vault de contatos — mão única, o Google nunca é alterado',
        dotId: 'gc-dot',
      })}
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

    <details class="disclosure-advanced conn-section conn-card" id="whatsapp-grupos">
      ${connCardSummary({
        icon: ICON_WHATSAPP,
        title: 'Grupos do WhatsApp',
        sub: 'Integração opcional com o WhatsApp Agent — grupos escolhidos viram nós no grafo de contatos, com quem está dentro',
        dotId: 'wa-dot',
      })}
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

    <details class="disclosure-advanced conn-section conn-card" id="instagram-contatos">
      ${connCardSummary({
        icon: ICON_INSTAGRAM,
        title: 'Conversas do Instagram',
        sub: 'Integração opcional com o Instagram Agent — conversas escolhidas viram contatos no grafo',
        dotId: 'ig-dot',
      })}
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

    <details class="disclosure-advanced conn-section conn-card" id="pipedrive-crm">
      ${connCardSummary({
        icon: ICON_FUNNEL,
        title: 'Pipedrive (CRM)',
        sub: 'Integração opcional — enriquece contatos existentes com dados do seu CRM, mão única',
        dotId: 'pd-dot',
      })}
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

    </div>
    </section>

    <section class="config-panel${activeTab === 'organizacao' ? ' active' : ''}" id="panel-organizacao" role="tabpanel" aria-labelledby="config-tab-organizacao" data-panel="organizacao">
    <p class="config-subtitle">Como o seu conteúdo se organiza: colunas do quadro de tarefas, pastas de projeto e as áreas e tipos do vault.</p>

    ${boardSection}

    ${projectsSection}

    ${tagsSection}

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
