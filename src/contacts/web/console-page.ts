// Página /app/graph do Expert Console (WS-1).
//
// Monta o HTML da casca do grafo: header (seletor de vault + busca + toggle de
// similares + legenda), #graph (canvas do sigma), #graph-panel (vazio, T3
// preenche). Carrega o bundle client (/app/console.bundle.js?v=hash). O vault
// inicial (?vault= ou 'contacts') vai num data-attr de #graph — CSP bloqueia
// inline JS, então NADA de window.__INIT__.

import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { NEBULA_CSS, FONT_LINKS } from './styles.js';
import { htmlResponse } from './render.js';
import { assetVersion } from './asset-version.js';
import { LAST_BACKUP_KEY } from '../backup/snapshot.js';
import { VAULTS } from '../vaults/types.js';
// Side-effect: registra o adapter 'contacts' no VAULTS (mesmo módulo que o handler
// já carrega). Importado aqui também pra garantir o registro server-side ao montar
// a página, independente da ordem de avaliação dos módulos.
import './graph-api.js';

interface VaultOption {
  id: string;
  name: string;
  color: string;
}

// SVG inline (CSP-safe — markup, não script).
const ICON_SEARCH =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>';
const ICON_FIT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const ICON_MENU =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

function vaultOptions(): VaultOption[] {
  const out = Object.values(VAULTS).map((v) => ({ id: v.id, name: v.name, color: v.color }));
  // Garante 'contacts' presente mesmo num cenário de registro tardio.
  if (!out.some((v) => v.id === 'contacts')) {
    out.unshift({ id: 'contacts', name: 'Contatos', color: '#22d3ee' });
  }
  return out;
}

// Casca da legenda — VAZIA no server. A legenda é VAULT-AWARE (cada vault expõe a
// sua via adapter.legend()), então quem a popula é o client (console.ts): no load
// inicial e a cada troca de vault, busca /app/graph/meta?vault= e preenche
// #graph-legend com os chips (key/label/color). Renderizar aqui server-side
// fixaria a legenda do vault inicial e mostraria categorias erradas após trocar
// de vault (era o bug do T4b). O contêiner #graph-legend existe sempre pro client
// achar; o título fica oculto até ter chips (classe is-empty).
function legendShellHtml(): string {
  return `<div class="graph-overlay-row graph-filter-header" id="graph-legend-title">Legenda</div>
    <div id="graph-legend" class="graph-chips is-empty" role="group" aria-label="Cores por categoria"></div>`;
}

export async function handleGraphPage(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const vault = (url.searchParams.get('vault') || 'contacts').trim() || 'contacts';
  const options = vaultOptions();
  const v = assetVersion('console.bundle.js');
  const vDetail = assetVersion('detail.bundle.js');

  const vaultSelectHtml = `
    <label class="sr-label" for="vault-select">Vault</label>
    <select id="vault-select" class="notes-select" aria-label="Selecionar vault">
      ${options
        .map(
          (o) =>
            `<option value="${esc(o.id)}"${o.id === vault ? ' selected' : ''}>${esc(o.name)}</option>`,
        )
        .join('')}
    </select>`;

  const body = `
    <div class="graph-wrap">
      <!-- Loading central sobre o canvas -->
      <div id="graph-loading" class="center-loading" role="status" aria-live="polite">
        <div class="center-loading-spinner" aria-hidden="true"></div>
        <div>Carregando grafo...</div>
      </div>

      <!-- Toggle do overlay (mobile) -->
      <button id="graph-overlay-toggle" class="graph-overlay-toggle" type="button"
        aria-label="Mostrar/ocultar painel" aria-controls="graph-overlay" aria-expanded="false">
        ${ICON_MENU}
      </button>

      <!-- OVERLAY ESQUERDO: vault + busca + similares + legenda -->
      <div id="graph-overlay" class="graph-overlay" role="region" aria-label="Controles do grafo">
        <div class="graph-overlay-row">${vaultSelectHtml}</div>

        <div class="graph-overlay-row graph-search-row">
          <span class="graph-search-icon" aria-hidden="true">${ICON_SEARCH}</span>
          <input type="search" id="graph-search-input" class="graph-search-input"
            placeholder="Buscar..." autocomplete="off" spellcheck="false" aria-label="Buscar no grafo">
        </div>

        <div id="graph-status" class="graph-overlay-row graph-status">Carregando...</div>

        <div class="graph-similar-controls">
          <label class="graph-check-label">
            <input type="checkbox" id="toggle-similar" checked>
            <span>Mostrar arestas similares</span>
          </label>
        </div>

        ${legendShellHtml()}

        <div class="graph-legend-line">
          <span class="legend-swatch swatch-explicit"></span> explícita
          <span class="legend-swatch swatch-similar"></span> similar
        </div>
      </div>

      <!-- Controles de zoom (direita) -->
      <div class="graph-zoom-controls" role="group" aria-label="Controles de zoom">
        <button id="graph-zoom-in" class="graph-zoom-btn" type="button" aria-label="Aproximar">+</button>
        <button id="graph-zoom-out" class="graph-zoom-btn" type="button" aria-label="Afastar">&minus;</button>
        <button id="graph-zoom-fit" class="graph-zoom-btn graph-zoom-fit" type="button" aria-label="Ajustar à tela">${ICON_FIT}</button>
      </div>

      <!-- Canvas do sigma. Vault inicial no data-attr (CSP-safe). -->
      <div id="graph" class="graph-canvas" role="img" aria-label="Grafo de contatos"
        data-vault="${esc(vault)}"></div>

      <!-- Painel de detalhe (T3 preenche). -->
      <div id="graph-panel" aria-hidden="true"></div>
    </div>

    <script src="/app/console.bundle.js?v=${esc(v)}" defer></script>
    <script src="/app/detail.bundle.js?v=${esc(vDetail)}" defer></script>`;

  const html = `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#070a13">
<title>Grafo · Expert Console</title>
${FONT_LINKS}
<link rel="preload" href="/app/console.bundle.js?v=${esc(v)}" as="script">
<style>${NEBULA_CSS}</style>
<style>
  body { overflow: hidden; }
  .main-graph { position: relative; z-index: 1; }
  /* Canvas minimal: esconde grão/nebula atrás dos nós (igual Brain). */
  .graph-wrap { background: #0c0c10; }
  #graph { cursor: grab; }
  #graph:active { cursor: grabbing; }
</style>
</head>
<body><div class="main-graph">${body}</div></body></html>`;

  return htmlResponse(html);
}

// Formata bytes pra exibição (KB/MB) na seção Backup.
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// Timestamp ISO → data/hora em Brasília (exibição do Console é sempre BRT).
function fmtBrt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ' (BRT)';
  } catch {
    return iso;
  }
}

// Card "Backup" do /app/config (spec 50-console-v2/67): status do último
// snapshot (lido do KV backup:last — quem grava é runSnapshotRecorded) + ações.
// CSP bloqueia JS inline e a página não tem bundle, então as ações são <form>
// POST (redireciona de volta com ?backup=ok|err) e link GET (download do ZIP).
async function backupCardHtml(env: Env, notice: string | null): Promise<string> {
  let statusHtml = '<p class="config-hint">Nenhum backup registrado ainda.</p>';
  try {
    const raw = await env.CACHE.get(LAST_BACKUP_KEY);
    if (raw) {
      const last = JSON.parse(raw);
      if (last.ok) {
        const tables = Object.entries(last.tables || {})
          .map(([t, n]) => `<code>${esc(t)}</code>: ${Number(n)}`)
          .join(' · ');
        statusHtml = `
    <p class="config-hint"><span class="badge-pill badge-ok">ok</span>
      Último snapshot: <strong>${esc(fmtBrt(String(last.finished_at)))}</strong> —
      ${Number(last.total_rows)} linhas, ${esc(fmtBytes(Number(last.bytes)))} em
      <code>${esc(String(last.prefix))}</code></p>
    <p class="config-hint">${tables}</p>`;
      } else {
        statusHtml = `
    <p class="config-hint"><span class="badge-pill badge-warn">falhou</span>
      Último backup FALHOU em ${esc(fmtBrt(String(last.finished_at)))}:
      <code>${esc(String(last.error))}</code></p>`;
      }
    }
  } catch {
    /* status ilegível não derruba a página de config */
  }

  const noticeHtml =
    notice === 'ok'
      ? '<p class="config-hint"><span class="badge-pill badge-ok">ok</span> Backup concluído agora.</p>'
      : notice === 'err'
        ? '<p class="config-hint"><span class="badge-pill badge-warn">erro</span> Backup falhou — veja o status abaixo.</p>'
        : '';

  return `
  <div class="card">
    <h2>Backup</h2>
    ${noticeHtml}
    ${statusHtml}
    <p class="config-hint">Snapshot semanal automático (segunda 02:30 BRT) grava todas as tabelas
    em JSON Lines no R2 (<code>backups/</code>, retém os últimos 8). O export baixa o mesmo
    snapshot em ZIP. <strong>O export contém TUDO, inclusive dados privados</strong> — guarde em
    lugar seguro. Restore é manual: <code>docs/restore.md</code>.</p>
    <form method="post" action="/app/backup/run" style="display:inline-block;margin-right:10px">
      <button type="submit" class="btn-primary">Fazer backup agora</button>
    </form>
    <a href="/app/export" class="btn-primary" style="display:inline-block;text-decoration:none">Baixar export (ZIP)</a>
  </div>`;
}

// Página simples /app/config — sobre + vault default + backup + logout. Sem bundle/canvas.
export async function handleConfigPage(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const backupCard = await backupCardHtml(env, url.searchParams.get('backup'));
  const options = vaultOptions();
  const rows = options
    .map(
      (o) =>
        `<tr><td><span class="badge" style="background:${esc(o.color)}22;border-color:${esc(
          o.color,
        )}55;color:${esc(o.color)}">${esc(o.name)}</span></td><td><code>${esc(o.id)}</code></td></tr>`,
    )
    .join('');

  const html = `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#070a13">
<title>Configuração · Expert Console</title>
${FONT_LINKS}
<style>${NEBULA_CSS}</style>
</head>
<body><div class="shell"><div class="main">
  <div class="page-header"><h1>Configuração</h1><span class="count">Expert Console</span></div>

  <div class="card">
    <h2>Sobre</h2>
    <p class="config-hint">Front único multi-vault — o cofre visual de contatos e conhecimento.
    Cada vault é um grafo de bolinhas (entidades) com arestas justificadas, igual ao Expert Brain.</p>
  </div>

  <div class="card">
    <h2>Vaults disponíveis</h2>
    <p class="config-hint">Vault padrão ao abrir o grafo: <code>contacts</code>.
    Troque pelo seletor no header do grafo.</p>
    <table class="keys-table">
      <thead><tr><th>Vault</th><th>ID</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="config-hint" style="margin-top:14px"><a href="/app/graph">← Voltar pro grafo</a></p>
  </div>

  ${backupCard}

  <div class="card">
    <h2>Sessão</h2>
    <form method="post" action="/app/logout">
      <button type="submit" class="btn-danger">Sair</button>
    </form>
  </div>

  <p class="config-hint" style="color:var(--text-faint)">${esc(origin)}</p>
</div></div></body></html>`;

  return htmlResponse(html);
}
