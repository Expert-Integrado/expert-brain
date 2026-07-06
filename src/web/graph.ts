import type { Env } from '../env.js';
import { requireSession, readCookie } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import { getGraphPrefs } from './graph-prefs.js';
import { esc } from '../util/html.js';

// O mesmo renderizador de grafo serve o vault do Brain (/app/graph) e o de Contatos
// embutido (/app/contacts) — muda só a FONTE de dados (graphSrc), que o bundle lê do
// data-attribute data-graph-src no #graph-canvas. Eric quer o Contatos DENTRO do
// Brain (mesma sidebar/URL, só o painel direito troca), não pulando pro Console.
export async function handleGraphPage(req: Request, env: Env): Promise<Response> {
  return renderGraphLikePage(req, env, { active: 'graph', graphSrc: '/app/graph', title: 'Graph' });
}

export async function handleContactsPage(req: Request, env: Env): Promise<Response> {
  return renderGraphLikePage(req, env, { active: 'contacts', graphSrc: '/app/contacts', title: 'Contatos' });
}

async function renderGraphLikePage(
  req: Request,
  env: Env,
  opts: { active: 'graph' | 'contacts'; graphSrc: string; title: string },
): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  // Contatos reusa o mesmo renderer, mas o painel é de NOTA — adapta o que não faz
  // sentido pra contato: o substantivo e a seção de similaridade (contatos não têm
  // arestas semânticas, é sempre 0). Forças/visual/isoladas valem pros dois.
  const isContacts = opts.active === 'contacts';
  const noun = isContacts ? 'contatos' : 'notas';

  // O modo 3D (palco WebGL/three) só existe no grafo do Brain. Contatos reusa o
  // mesmo renderer 2D, mas não tem arestas semânticas/kind — 3D lá não agrega.
  const can3D = !isContacts;

  // Config salva do dono (forças, cores, anti-sobreposição), POR SUPERFÍCIE
  // (spec 29): Contatos e Notas têm chaves próprias no meta — salvar sliders num
  // não sobrescreve o outro. Injetada como data-attribute no #graph-canvas (CSP
  // é script-src 'self', sem inline script); o cliente lê e aplica antes de
  // inicializar a simulação. '' = usa os defaults.
  const savedPrefs = await getGraphPrefs(env, isContacts ? 'contacts' : 'notes');
  const prefsAttr = savedPrefs ? esc(JSON.stringify(savedPrefs)) : '';

  // Modo inicial do palco: SEMPRE 2D ao recarregar (spec 29) — 3D é escolha
  // explícita, só via ?mode=3d (deep-link/toggle na sessão). A pref salva NÃO
  // entra mais na equação: salvar padrão estando no 3D prendia o boot no 3D.
  const url = new URL(req.url);
  const queryMode = url.searchParams.get('mode');
  const initialMode: '2d' | '3d' = can3D && queryMode === '3d' ? '3d' : '2d';

  // Painel de controles recolhido? Lido do cookie pra renderizar já no estado
  // certo (sem flash). Toggle client-side grava o cookie.
  const panelCollapsed = readCookie(req.headers.get('cookie'), 'eb_graphpanel') === 'collapsed';

  const body = `
    <style>
      /* Phase A.2 — Obsidian-style aggressive (2026-05-01):
         Background neutral dark, no lavender overlay. Sidebar+grain do app
         seguem com gradient nebula, mas o canvas do graph é minimal.
         Mais escuro que Obsidian (#1e1e1e) propositalmente — Brain assina
         numa palette mais profunda. */
      /* position:relative é o positioning context do palco: sem isso, o
         inset:0 de #graph3d-loading (e do próprio #graph-canvas) sobe pro
         ancestral posicionado mais próximo (.main:has(#graph-canvas), que
         tem outro box) em vez de centralizar no palco — era isso que jogava
         o spinner de loading do 3D pro canto superior-esquerdo, atrás da
         caixa de busca (bug reportado 2026-07). */
      .graph-wrap { background: #0c0c10; position: relative; }
      #graph-canvas { cursor: grab; }
      #graph-canvas:active { cursor: grabbing; }
      #graph-canvas .sigma-labels {
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 6px rgba(0, 0, 0, 0.85);
      }
      /* Hide the body grain/nebula behind the graph canvas — they fight the nodes. */
      .main:has(#graph-canvas) {
        max-width: none;
        width: auto;
        padding: 0;
        background: #0c0c10;
        position: relative;
        z-index: 2;
      }
      /* Overlay panel mais clean: preto-grafite em vez de violeta-tinted */
      .main:has(#graph-canvas) .graph-overlay {
        background: rgba(14, 14, 18, 0.88);
        border-color: rgba(255, 255, 255, 0.08);
      }
      .main:has(#graph-canvas) .graph-zoom-controls {
        background: rgba(14, 14, 18, 0.88);
        border-color: rgba(255, 255, 255, 0.08);
      }
      /* A.22 — Display + Forces sections */
      .graph-section {
        margin-top: 8px;
        padding: 6px 8px;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 6px;
        background: rgba(255,255,255,0.02);
      }
      .graph-section[open] { padding-bottom: 8px; }
      .graph-section-summary {
        cursor: pointer;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: rgba(255,255,255,0.55);
        font-weight: 500;
        user-select: none;
        padding: 2px 0;
      }
      .graph-section-summary:hover { color: rgba(255,255,255,0.85); }
      .graph-section .graph-slider-label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-top: 6px;
        font-size: 11px;
        color: rgba(255,255,255,0.7);
      }
      .graph-section .graph-slider-label input[type=range] { width: 100%; }
      .graph-section .graph-check-label { margin-top: 6px; }
      .graph-section .graph-reset-btn { margin-top: 8px; }
      /* A.29 — Hide orphans + Restore default no fim */
      .graph-orphans-toggle { display: flex; margin: 6px 0 4px; padding: 0 4px; }
      .graph-reset-all {
        display: block;
        width: 100%;
        margin-top: 12px;
        padding: 6px 10px;
        font-size: 11px;
      }
      /* A.30 — Microcopy embaixo dos sliders (Forasteiro: sem isso, tradução é teatro). */
      .graph-slider-help {
        display: block;
        margin-top: 1px;
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        line-height: 1.3;
      }
      /* A.30 — Indicador de filtro ativo no topo (Contrário: crítico pós-A.29). */
      .graph-active-filters {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        margin: 4px 0;
        font-size: 11px;
        background: rgba(167, 139, 250, 0.12);
        border: 1px solid rgba(167, 139, 250, 0.3);
        border-radius: 6px;
        color: rgba(220, 200, 255, 0.95);
      }
      .graph-active-filters.show { display: flex; }
      .graph-active-filters button {
        margin-left: auto;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.2);
        color: rgba(255,255,255,0.85);
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 4px;
        cursor: pointer;
      }
      .graph-active-filters button:hover { background: rgba(255,255,255,0.06); }
      /* A.35 — Chips inline pra Coloração (substituiu <select>). */
      .graph-color-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .graph-color-chip {
        flex: 1 1 auto;
        min-width: 0;
        padding: 4px 8px;
        font-size: 10px;
        font-family: inherit;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 4px;
        color: rgba(255,255,255,0.65);
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        white-space: nowrap;
      }
      .graph-color-chip:hover { background: rgba(255,255,255,0.08); color: #f4ecff; }
      .graph-color-chip.active {
        background: rgba(167, 139, 250, 0.2);
        border-color: rgba(167, 139, 250, 0.6);
        color: #f4ecff;
      }
      /* A.31 — Cmd+K command palette */
      .graph-palette-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(4px);
        z-index: 9000;
        display: none;
        align-items: flex-start;
        justify-content: center;
        padding-top: 12vh;
      }
      .graph-palette-backdrop.open { display: flex; }
      .graph-palette {
        width: min(560px, 90vw);
        max-height: 60vh;
        background: rgba(20, 20, 26, 0.98);
        border: 1px solid rgba(167, 139, 250, 0.3);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .graph-palette-input {
        width: 100%;
        padding: 14px 16px;
        background: transparent;
        border: 0;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        color: #f4ecff;
        font-size: 14px;
        font-family: inherit;
        outline: none;
      }
      .graph-palette-input::placeholder { color: rgba(255,255,255,0.35); }
      .graph-palette-list {
        list-style: none;
        margin: 0;
        padding: 4px 0;
        overflow-y: auto;
        flex: 1;
      }
      .graph-palette-item {
        padding: 8px 16px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        border-left: 2px solid transparent;
      }
      .graph-palette-item.active {
        background: rgba(167, 139, 250, 0.12);
        border-left-color: rgba(167, 139, 250, 0.7);
      }
      .graph-palette-item-title { color: #f4ecff; font-size: 13px; }
      .graph-palette-item-meta { color: rgba(255,255,255,0.45); font-size: 11px; }
      .graph-palette-empty { padding: 16px; text-align: center; color: rgba(255,255,255,0.4); font-size: 12px; }
      .graph-palette-hint {
        padding: 6px 16px;
        font-size: 10px;
        color: rgba(255,255,255,0.4);
        background: rgba(0,0,0,0.25);
        border-top: 1px solid rgba(255,255,255,0.05);
      }
      /* A.32 — Botão "Mostrar conexões sugeridas" + lista de sugestões */
      .graph-suggested-row { margin-top: 10px; }
      .graph-suggested-row button {
        width: 100%;
        background: rgba(255, 200, 100, 0.08);
        border: 1px dashed rgba(255, 200, 100, 0.4);
        color: rgba(255, 220, 160, 0.9);
        padding: 6px 10px;
        font-size: 11px;
        border-radius: 6px;
        cursor: pointer;
      }
      .graph-suggested-row button:hover { background: rgba(255, 200, 100, 0.15); }
      .graph-suggested-row button.active {
        background: rgba(255, 200, 100, 0.18);
        border-style: solid;
      }
      .graph-suggest-modal-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(4px);
        z-index: 9100;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .graph-suggest-modal-backdrop.open { display: flex; }
      .graph-suggest-modal {
        width: min(540px, 100%);
        background: rgba(20, 20, 26, 0.98);
        border: 1px solid rgba(255, 200, 100, 0.4);
        border-radius: 12px;
        padding: 20px;
        color: #f4ecff;
      }
      .graph-suggest-modal h3 { margin: 0 0 4px; font-size: 14px; color: rgba(255, 220, 160, 0.95); }
      .graph-suggest-modal .pair { display: flex; gap: 8px; align-items: center; margin: 10px 0; }
      .graph-suggest-modal .pair span { flex: 1; font-size: 13px; padding: 6px 10px; background: rgba(255,255,255,0.04); border-radius: 6px; }
      .graph-suggest-modal .arrow { color: rgba(255, 200, 100, 0.7); }
      .graph-suggest-modal textarea {
        width: 100%;
        min-height: 80px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        color: #f4ecff;
        padding: 8px 10px;
        font-family: inherit;
        font-size: 12px;
        margin-top: 6px;
      }
      .graph-suggest-modal-actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
      .graph-suggest-modal-actions button {
        padding: 6px 14px; border-radius: 6px; font-size: 12px;
        cursor: pointer; border: 1px solid rgba(255,255,255,0.15);
        background: rgba(255,255,255,0.05); color: #f4ecff;
      }
      .graph-suggest-modal-actions button.primary {
        background: rgba(255, 200, 100, 0.2);
        border-color: rgba(255, 200, 100, 0.5);
      }
      .graph-suggest-modal-actions button:disabled { opacity: 0.5; cursor: not-allowed; }

      /* Tooltip CSS-only (sem JS, ok com CSP) pra explicar os botões/seções.
         Aparece no hover e no foco por teclado. data-tip no elemento. */
      .has-tip { position: relative; }
      .has-tip::after {
        content: attr(data-tip);
        position: absolute;
        left: 50%;
        bottom: calc(100% + 8px);
        transform: translateX(-50%) translateY(4px);
        width: max-content;
        max-width: 220px;
        padding: 7px 10px;
        background: rgba(20, 20, 26, 0.98);
        border: 1px solid rgba(167, 139, 250, 0.35);
        border-radius: 6px;
        color: #f4ecff;
        font-size: 11px;
        font-weight: 400;
        line-height: 1.35;
        text-align: left;
        white-space: normal;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
        opacity: 0;
        pointer-events: none;
        transition: opacity 140ms var(--ease, ease), transform 140ms var(--ease, ease);
        z-index: 9500;
      }
      .has-tip:hover::after,
      .has-tip:focus-visible::after { opacity: 1; transform: translateX(-50%) translateY(0); }
      /* Zoom controls ficam na borda direita — tooltip abre pra esquerda pra não vazar. */
      .graph-zoom-controls .has-tip::after { left: auto; right: calc(100% + 8px); bottom: 50%; transform: translateY(50%) translateX(4px); }
      .graph-zoom-controls .has-tip:hover::after,
      .graph-zoom-controls .has-tip:focus-visible::after { transform: translateY(50%) translateX(0); }
      /* Ícone ⓘ ao lado dos títulos de seção. */
      .graph-info-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        margin-left: 6px;
        border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.35);
        color: rgba(255,255,255,0.6);
        font-size: 9px;
        font-style: normal;
        font-weight: 700;
        cursor: help;
        vertical-align: middle;
      }
      .graph-info-icon:hover { color: var(--accent-lav, #a78bfa); border-color: var(--accent-lav, #a78bfa); }

      /* Botão de recolher o painel de controles do grafo — deixa só a busca. */
      .graph-search-row { position: relative; }
      .graph-search-row .graph-search-input { padding-right: 32px; }
      /* ✕ da busca — só aparece com texto digitado (CSS :has + :placeholder-shown,
         reage até a limpeza programática, zero JS de estado). Fica à esquerda do
         botão de recolher; limpa SÓ a busca. */
      .graph-search-clear {
        position: absolute;
        right: 32px;
        top: 50%;
        transform: translateY(-50%);
        width: 22px;
        height: 22px;
        display: none;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: 50%;
        color: var(--text-faint, #8b87a0);
        cursor: pointer;
        padding: 0;
      }
      .graph-search-clear:hover { color: var(--text, #e8e6f0); background: rgba(167, 139, 250, 0.18); }
      .graph-search-row:has(.graph-search-input:not(:placeholder-shown)) .graph-search-clear { display: inline-flex; }
      .graph-search-row:has(.graph-search-input:not(:placeholder-shown)) .graph-search-input { padding-right: 58px; }
      .graph-panel-toggle {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: 5px;
        color: rgba(255, 255, 255, 0.5);
        cursor: pointer;
        transition: color 140ms ease, background 140ms ease;
      }
      .graph-panel-toggle:hover { color: var(--accent-lav, #a78bfa); background: rgba(255, 255, 255, 0.08); }
      .graph-panel-toggle svg { transition: transform 200ms ease; }
      /* Recolhido: esconde tudo menos a barra de busca; chevron inverte. */
      .graph-overlay.collapsed #graph-overlay-body { display: none; }
      .graph-overlay.collapsed .graph-panel-toggle svg { transform: rotate(180deg); }

      /* ── Palco 3D (o "globo que gira") — vive na MESMA tela do 2D, empilhado
         atrás do overlay de controles (mesmo z-index base do #graph-canvas).
         Só um dos dois palcos fica visível por vez; o toggle 2D/3D troca a
         classe .mode-3d no .graph-wrap. O painel esquerdo NUNCA some. */
      #graph3d-stage {
        position: absolute;
        inset: 0;
        z-index: 0;
        background: #0c0c10;
        display: none;      /* aceso via .graph-wrap.mode-3d abaixo */
      }
      #graph3d-stage canvas { display: block; }  /* three insere <canvas> bloco */
      .graph-wrap.mode-3d #graph3d-stage { display: block; }
      /* Em 3D, o canvas 2D (Sigma) e seus overlays saem de cena — mas seguem no
         DOM (o cliente só troca a visibilidade, sem destruir a instância Sigma). */
      .graph-wrap.mode-3d #graph-canvas { visibility: hidden; pointer-events: none; }
      /* Spinner de carregamento do bundle 3D (lazy). Centralizado no palco
         (.graph-wrap, position:relative) via inset:0 + flex center — antes
         faltava align-items/justify-content, então o flex container ocupava
         a tela toda mas o conteúdo ficava colado no canto superior-esquerdo
         (default align-items:stretch + justify-content:flex-start), atrás da
         caixa de busca. z-index 5 fica ACIMA do palco 3D (#graph3d-stage z=0)
         e do canvas 2D, mas ABAIXO do painel esquerdo e da busca (.graph-overlay
         e .graph-zoom-controls, ambos z-index 10) — mesmo z-index do
         .center-loading 2D (#graph-center-loading), que segue a mesma regra.
         Funciona também no caminho SSR direto (?mode=3d): a classe
         .mode-3d-loading já vem injetada pelo server no HTML inicial (ver
         initialMode acima), então o centering não depende de JS rodar. */
      #graph3d-loading {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: none;
        align-items: center;
        justify-content: center;
      }
      .graph-wrap.mode-3d.mode-3d-loading #graph3d-loading { display: flex; }
    </style>

    <div class="graph-wrap${can3D && initialMode === '3d' ? ' mode-3d mode-3d-loading' : ''}" data-graph-initial-mode="${initialMode}">
      <!-- Loading centralizado sobre o canvas — escondido após primeiro render. -->
      <div id="graph-center-loading" class="center-loading" role="status" aria-live="polite">
        <div class="center-loading-spinner" aria-hidden="true"></div>
        <div>Carregando grafo...</div>
      </div>
      ${can3D ? `<!-- Palco 3D — preenchido pelo bundle graph3d lazy-load. Mesmo payload
           /app/graph/data do 2D; os controles do painel esquerdo comandam os dois. -->
      <div id="graph3d-stage" role="img" aria-label="Grafo de conhecimento em 3D"></div>
      <div id="graph3d-loading" class="center-loading" role="status" aria-live="polite">
        <div class="center-loading-spinner" aria-hidden="true"></div>
        <div>Carregando grafo 3D...</div>
      </div>` : ''}
      <!-- Mobile-only toggle do overlay (escondido em desktop via CSS).
           Permite fechar o painel pra interagir com o canvas no mobile. -->
      <button
        id="graph-overlay-toggle"
        class="graph-overlay-toggle"
        type="button"
        aria-label="Mostrar/ocultar painel de controles"
        aria-controls="graph-overlay"
        aria-expanded="false"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <!-- LEFT OVERLAY: search + filters + status -->
      <div id="graph-overlay" class="graph-overlay${panelCollapsed ? ' collapsed' : ''}" role="region" aria-label="Graph controls">
        <div class="graph-overlay-row graph-search-row">
          <span class="graph-search-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
          </span>
          <input
            type="search"
            id="graph-search-input"
            class="graph-search-input"
            placeholder="Buscar ${noun} (/ pra focar, Enter pra abrir)"
            autocomplete="off"
            spellcheck="false"
            aria-label="Buscar ${noun}"
          />
          <button
            id="graph-search-clear"
            class="graph-search-clear"
            type="button"
            aria-label="Limpar busca"
            title="Limpar busca (só a busca — filtros e visual ficam)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <button
            id="graph-panel-toggle"
            class="graph-panel-toggle"
            type="button"
            aria-label="Recolher filtros"
            aria-expanded="true"
            title="Recolher filtros — deixa só a busca"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <!-- Dropdown typeahead da busca: lista ranqueada de ${noun} (client preenche).
               Absoluto sob a linha da busca (.graph-search-row é position:relative). -->
          <div id="graph-search-results" class="graph-search-results" role="listbox" aria-label="Resultados da busca" hidden></div>
        </div>

        <div id="graph-overlay-body">
        <div id="graph-count" class="graph-overlay-row graph-status">Carregando...</div>

        <!-- A.30 — Indicador de filtro ativo (Contrário: crítico pra leigo não achar que "quebrou"). -->
        <div id="graph-active-filters" class="graph-active-filters" aria-live="polite">
          <span id="graph-active-filters-text">Sem filtros</span>
          <button data-graph-action="clear-filters" type="button" title="Limpa busca e filtros de categoria — não mexe no visual nem nas forças">Limpar</button>
        </div>

        <div class="graph-overlay-row graph-filter-header">${isContacts ? 'Tipo' : 'Áreas'}</div>
        <div id="graph-legend" class="graph-chips" role="group" aria-label="Filtrar"></div>

        <div class="graph-overlay-row graph-filter-header"${isContacts ? ' style="display:none"' : ''}>Tipos</div>
        <div id="graph-kinds" class="graph-chips" role="group" aria-label="Filtrar por tipo"${isContacts ? ' style="display:none"' : ''}></div>

        <label class="graph-check-label graph-orphans-toggle">
          <input type="checkbox" id="hide-orphans" />
          <span>Esconder isoladas</span>
        </label>

        <details class="graph-section" open${isContacts ? ' style="display:none"' : ''}>
          <summary class="graph-section-summary">Notas parecidas<i class="graph-info-icon" title="Linhas semânticas conectam notas com conteúdo parecido (mesmo sem ligação explícita). Ajuste a intensidade, esconda, ou mostre conexões sugeridas pra criar links.">i</i></summary>
          <label class="graph-slider-label">
            <span>Intensidade</span>
            <input
              type="range"
              id="similar-opacity"
              min="0"
              max="100"
              value="18"
              aria-label="Intensidade das linhas semânticas"
            />
            <small class="graph-slider-help">Linhas que conectam notas semanticamente parecidas</small>
          </label>
          <label class="graph-check-label">
            <input type="checkbox" id="similar-hide" />
            <span>Esconder</span>
          </label>
          <!-- A.35 — chips inline pra Coloração (substituiu select; popup nativo
               do <select> ignorava CSS em dark mode em vários browsers/SOs). -->
          <div class="graph-slider-label">
            <span>Coloração das bolinhas</span>
            <div id="color-mode-chips" class="graph-color-chips" role="radiogroup" aria-label="Modo de coloração">
              <button type="button" class="graph-color-chip active" data-color-mode="neutral">Neutra</button>
              <button type="button" class="graph-color-chip" data-color-mode="domain">Por área</button>
              <button type="button" class="graph-color-chip" data-color-mode="kind">Por tipo</button>
              <button type="button" class="graph-color-chip" data-color-mode="degree">Por grau</button>
            </div>
            <small class="graph-slider-help">Como as bolinhas são coloridas no grafo</small>
          </div>
          <!-- A.32 — Suggested links toggle -->
          <div class="graph-suggested-row">
            <button id="suggested-toggle" type="button" data-graph-action="toggle-suggested">Mostrar conexões sugeridas</button>
            <small class="graph-slider-help">Linhas tracejadas amarelas mostrando pares de notas com alta similaridade que ainda não têm ligação explícita. Clique numa pra criar a ligação justificada.</small>
          </div>
        </details>

        <!-- A.30 — Forces aberto / Display fechado (Contrário: power-user mexe em forças, não em display) -->
        <details class="graph-section" open>
          <summary class="graph-section-summary">Forças<i class="graph-info-icon" title="Controlam o layout físico do grafo: o quanto os nós se atraem, se repelem e a distância das ligações. Mexa pra espalhar ou compactar o grafo.">i</i></summary>
          <label class="graph-slider-label">
            <span>Quão centralizado</span>
            <input type="range" id="force-center" min="0" max="1" step="0.01" value="0.1" aria-label="Força de centralização" />
            <small class="graph-slider-help">Puxa o grafo todo pro centro da tela</small>
          </label>
          <label class="graph-slider-label">
            <span>Quanto se repelem</span>
            <input type="range" id="force-repel" min="0" max="20" step="0.1" value="10" aria-label="Força de repulsão" />
            <small class="graph-slider-help">Afasta as bolinhas umas das outras</small>
          </label>
          <label class="graph-slider-label">
            <span>Força das ligações</span>
            <input type="range" id="force-link" min="0" max="1" step="0.01" value="1" aria-label="Força do link" />
            <small class="graph-slider-help">Quão firme as linhas puxam as bolinhas conectadas</small>
          </label>
          <label class="graph-slider-label">
            <span>Comprimento das ligações</span>
            <input type="range" id="force-distance" min="30" max="500" step="5" value="250" aria-label="Distância do link" />
            <small class="graph-slider-help">Distância natural entre bolinhas conectadas</small>
          </label>
          <label class="graph-check-label">
            <input type="checkbox" id="no-overlap" />
            <span>Não sobrepor as bolinhas</span>
          </label>
          <small class="graph-slider-help">Força as bolinhas a não ficarem em cima umas das outras (colisão forte)</small>
        </details>

        <details class="graph-section">
          <summary class="graph-section-summary">Visual<i class="graph-info-icon" title="Aparência do grafo: tamanho das bolinhas, espessura das linhas e quão cedo os nomes das notas aparecem ao dar zoom.">i</i></summary>
          <label class="graph-slider-label">
            <span>Tamanho das bolinhas</span>
            <input type="range" id="node-size-mult" min="0.3" max="3" step="0.1" value="1" aria-label="Tamanho dos nós" />
            <small class="graph-slider-help">Multiplicador global do tamanho dos nós</small>
          </label>
          <label class="graph-slider-label">
            <span>Espessura das linhas</span>
            <input type="range" id="line-size-mult" min="0" max="3" step="0.1" value="1" aria-label="Espessura das linhas explícitas" />
            <small class="graph-slider-help">Espessura das ligações explícitas (links justificados)</small>
          </label>
          <label class="graph-slider-label">
            <span>Aparição dos rótulos</span>
            <input type="range" id="text-fade-mult" min="-3" max="3" step="0.1" value="0" aria-label="Fade do texto" />
            <small class="graph-slider-help">Quão cedo os nomes das notas aparecem ao dar zoom</small>
          </label>
        </details>

        <button id="graph-save-prefs" class="graph-reset-btn graph-reset-all" data-graph-action="save-prefs" title="Salva forças, cores, visual e não-sobrepor como seu padrão — abre sempre assim e o Restaurar padrão volta pra cá (sincroniza entre seus dispositivos)">Salvar como padrão</button>
        <button class="graph-reset-btn graph-reset-all" data-graph-action="reset-all" title="Volta tudo pro SEU padrão salvo (ou o inicial, se nunca salvou) e limpa busca, filtros e posições">Restaurar padrão</button>

        <div class="graph-legend-line">
          <span class="legend-swatch swatch-explicit"></span> explícita
          <span class="legend-swatch swatch-similar"></span> semântica
          <span style="margin-left:auto; font-size:10px; color:rgba(255,255,255,0.4); font-variant-numeric:tabular-nums;">v A.35</span>
        </div>
        </div><!-- /#graph-overlay-body -->
      </div>

      <!-- RIGHT FLOATING: zoom controls -->
      <div class="graph-zoom-controls" role="group" aria-label="Controles de zoom">
        <button class="graph-zoom-btn has-tip" data-graph-action="zoom-in" data-tip="Aproximar o grafo" aria-label="Aproximar">+</button>
        <button class="graph-zoom-btn has-tip" data-graph-action="zoom-out" data-tip="Afastar o grafo" aria-label="Afastar">&minus;</button>
        <button class="graph-zoom-btn graph-zoom-fit has-tip" data-graph-action="fit" data-tip="Ajustar à tela: recentraliza e enquadra o grafo inteiro" aria-label="Ajustar à tela">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>
        ${can3D ? `<!-- Toggle 2D/3D: troca o PALCO na MESMA tela (sidebar/filtros ficam).
             O bundle 3D (1.35MB) só é injetado quando liga (lazy). data-graph3d-src
             guarda a URL versionada do bundle pro cliente injetar sob demanda. -->
        <button
          class="graph-zoom-btn graph-mode-toggle has-tip"
          type="button"
          data-graph-action="toggle-3d"
          data-graph3d-src="/app/graph3d/bundle.js?v=${assetVersion('graph3d.bundle.js')}"
          data-tip="Alternar 2D / 3D — o globo que gira"
          aria-label="Alternar entre grafo 2D e 3D"
          aria-pressed="${initialMode === '3d' ? 'true' : 'false'}"
          style="font-size:11px;font-weight:600;"
        >${initialMode === '3d' ? '2D' : '3D'}</button>` : ''}
      </div>

      <div id="graph-canvas" class="graph-canvas" role="img" aria-label="Grafo de conhecimento" data-sw-ver="${assetVersion('sim-worker.bundle.js')}" data-graph-prefs="${prefsAttr}" data-graph-src="${opts.graphSrc}" data-vault="${isContacts ? 'contacts' : 'notes'}"></div>

      <!-- A.31 — Cmd+K command palette -->
      <div id="graph-palette-backdrop" class="graph-palette-backdrop" role="dialog" aria-label="Buscar nota">
        <div class="graph-palette">
          <input
            id="graph-palette-input"
            class="graph-palette-input"
            type="search"
            placeholder="Buscar por nome ou conteúdo... (↑↓ navega · Enter abre · Esc fecha)"
            autocomplete="off"
            spellcheck="false"
          />
          <ul id="graph-palette-list" class="graph-palette-list"></ul>
          <div class="graph-palette-hint">⌘K / Ctrl+K abre · Enter teleporta a câmera + abre o painel da nota</div>
        </div>
      </div>

      <!-- A.32 — Suggested links modal -->
      <div id="graph-suggest-modal-backdrop" class="graph-suggest-modal-backdrop" role="dialog" aria-label="Sugestão de ligação">
        <div class="graph-suggest-modal">
          <h3>Conexão sugerida</h3>
          <p style="font-size:12px; color:rgba(255,255,255,0.55); margin:0">Notas semanticamente próximas que ainda não têm ligação explícita. Edite a justificativa e crie a ligação se fizer sentido.</p>
          <div class="pair">
            <span id="suggest-from"></span>
            <span class="arrow">↔</span>
            <span id="suggest-to"></span>
          </div>
          <label style="font-size:11px; color:rgba(255,255,255,0.65); display:block;">
            Por que se conectam?
            <textarea id="suggest-why" placeholder="Ex: ambas tratam de filtros mentais que distorcem decisão"></textarea>
          </label>
          <div class="graph-suggest-modal-actions">
            <button data-graph-action="suggest-cancel" type="button">Cancelar</button>
            <button id="suggest-create-btn" data-graph-action="suggest-create" class="primary" type="button">Criar ligação</button>
          </div>
        </div>
      </div>
    </div>

    <script src="/app/graph/bundle.js?v=${assetVersion('graph.bundle.js')}" defer></script>
  `;

  // Preload do bundle pesado do graph (210KB+) — browser começa o download
  // em paralelo com o parse do HTML, cortando ~100-300ms do tempo até render.
  // Mesma URL versionada do <script> pra reusar o download (senão baixa 2x).
  const extraHead = `<link rel="preload" href="/app/graph/bundle.js?v=${assetVersion('graph.bundle.js')}" as="script">`;

  return htmlResponse(
    await renderShell({ title: opts.title, active: opts.active, email: session.email, env, body, extraHead, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}
