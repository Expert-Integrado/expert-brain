import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse } from './render.js';

export async function handleGraphPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const body = `
    <style>
      /* Phase A.2 — Obsidian-style aggressive (2026-05-01):
         Background neutral dark, no lavender overlay. Sidebar+grain do app
         seguem com gradient nebula, mas o canvas do graph é minimal.
         Mais escuro que Obsidian (#1e1e1e) propositalmente — Brain assina
         numa palette mais profunda. */
      .graph-wrap { background: #0c0c10; }
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
    </style>

    <div class="graph-wrap">
      <!-- Loading centralizado sobre o canvas — escondido após primeiro render. -->
      <div id="graph-center-loading" class="center-loading" role="status" aria-live="polite">
        <div class="center-loading-spinner" aria-hidden="true"></div>
        <div>Carregando grafo...</div>
      </div>
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
      <div id="graph-overlay" class="graph-overlay" role="region" aria-label="Graph controls">
        <div class="graph-overlay-row graph-search-row">
          <span class="graph-search-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
          </span>
          <input
            type="search"
            id="graph-search-input"
            class="graph-search-input"
            placeholder="Buscar notas (/ pra focar, Enter pra abrir)"
            autocomplete="off"
            spellcheck="false"
            aria-label="Buscar notas"
          />
        </div>

        <div id="graph-count" class="graph-overlay-row graph-status">Carregando...</div>

        <!-- A.30 — Indicador de filtro ativo (Contrário: crítico pra leigo não achar que "quebrou"). -->
        <div id="graph-active-filters" class="graph-active-filters" aria-live="polite">
          <span id="graph-active-filters-text">Sem filtros</span>
          <button data-graph-action="clear-filters" type="button">Limpar</button>
        </div>

        <div class="graph-overlay-row graph-filter-header">Áreas</div>
        <div id="graph-legend" class="graph-chips" role="group" aria-label="Filtrar por área"></div>

        <div class="graph-overlay-row graph-filter-header">Tipos</div>
        <div id="graph-kinds" class="graph-chips" role="group" aria-label="Filtrar por tipo"></div>

        <label class="graph-check-label graph-orphans-toggle">
          <input type="checkbox" id="hide-orphans" />
          <span>Esconder isoladas</span>
        </label>

        <details class="graph-section" open>
          <summary class="graph-section-summary">Notas parecidas</summary>
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
          <summary class="graph-section-summary">Forças</summary>
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
        </details>

        <details class="graph-section">
          <summary class="graph-section-summary">Visual</summary>
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

        <button class="graph-reset-btn graph-reset-all" data-graph-action="reset-all" title="Volta filtros, visual, forças e posições para o estado inicial">Restaurar padrão</button>

        <div class="graph-legend-line">
          <span class="legend-swatch swatch-explicit"></span> explícita
          <span class="legend-swatch swatch-similar"></span> semântica
          <span style="margin-left:auto; font-size:10px; color:rgba(255,255,255,0.4); font-variant-numeric:tabular-nums;">v A.35</span>
        </div>
      </div>

      <!-- RIGHT FLOATING: zoom controls -->
      <div class="graph-zoom-controls" role="group" aria-label="Controles de zoom">
        <button class="graph-zoom-btn" data-graph-action="zoom-in" title="Aproximar" aria-label="Aproximar">+</button>
        <button class="graph-zoom-btn" data-graph-action="zoom-out" title="Afastar" aria-label="Afastar">&minus;</button>
        <button class="graph-zoom-btn graph-zoom-fit" data-graph-action="fit" title="Ajustar à tela" aria-label="Ajustar à tela">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>
      </div>

      <div id="graph-canvas" class="graph-canvas" role="img" aria-label="Grafo de conhecimento"></div>

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

    <script src="/app/graph/bundle.js?v=${Date.now()}" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Graph', active: 'graph', email: session.email, body })
  );
}
