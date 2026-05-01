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
    </style>

    <div class="graph-wrap">
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
            placeholder="Search notes (press / to focus, Enter to jump)"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div id="graph-count" class="graph-overlay-row graph-status">Loading...</div>

        <div class="graph-overlay-row graph-filter-header">
          <span>Domains</span>
          <button class="graph-reset-btn" data-graph-action="reset-filters" title="Limpa filtros e volta o grafo ao layout original">reset</button>
        </div>
        <div id="graph-legend" class="graph-chips" role="group" aria-label="Filter by domain"></div>

        <div class="graph-overlay-row graph-filter-header">Kinds</div>
        <div id="graph-kinds" class="graph-chips" role="group" aria-label="Filter by kind"></div>

        <div class="graph-overlay-row graph-similar-controls">
          <label class="graph-slider-label">
            <span>Similar edges</span>
            <input
              type="range"
              id="similar-opacity"
              min="0"
              max="100"
              value="18"
              aria-label="Similar edge opacity"
            />
          </label>
          <label class="graph-check-label">
            <input type="checkbox" id="similar-hide" />
            <span>Hide</span>
          </label>
          <label class="graph-check-label">
            <input type="checkbox" id="show-colors" />
            <span>Color by domain</span>
          </label>
        </div>

        <details class="graph-section" open>
          <summary class="graph-section-summary">Display</summary>
          <label class="graph-slider-label">
            <span>Node size</span>
            <input type="range" id="node-size-mult" min="0.3" max="3" step="0.1" value="1" />
          </label>
          <label class="graph-slider-label">
            <span>Line thickness</span>
            <input type="range" id="line-size-mult" min="0.2" max="3" step="0.1" value="1" />
          </label>
          <label class="graph-slider-label">
            <span>Text fade</span>
            <input type="range" id="text-fade-mult" min="-3" max="3" step="0.1" value="0" />
          </label>
          <label class="graph-check-label">
            <input type="checkbox" id="hide-orphans" />
            <span>Hide orphans</span>
          </label>
        </details>

        <details class="graph-section">
          <summary class="graph-section-summary">Forces</summary>
          <label class="graph-slider-label">
            <span>Center force</span>
            <input type="range" id="force-center" min="0" max="2" step="0.01" value="0.5" />
          </label>
          <label class="graph-slider-label">
            <span>Repel force</span>
            <input type="range" id="force-repel" min="1" max="100" step="1" value="18" />
          </label>
          <label class="graph-slider-label">
            <span>Link strength</span>
            <input type="range" id="force-link" min="0" max="2" step="0.05" value="1" />
          </label>
          <button class="graph-reset-btn" data-graph-action="reset-forces" title="Volta os forces ao default">restore default</button>
        </details>

        <div class="graph-legend-line">
          <span class="legend-swatch swatch-explicit"></span> explicit
          <span class="legend-swatch swatch-similar"></span> similar
          <span style="margin-left:auto; font-size:10px; color:rgba(255,255,255,0.4); font-variant-numeric:tabular-nums;">v A.26</span>
        </div>
      </div>

      <!-- RIGHT FLOATING: zoom controls -->
      <div class="graph-zoom-controls" role="group" aria-label="Zoom controls">
        <button class="graph-zoom-btn" data-graph-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        <button class="graph-zoom-btn" data-graph-action="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
        <button class="graph-zoom-btn graph-zoom-fit" data-graph-action="fit" title="Fit to screen" aria-label="Fit to screen">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>
      </div>

      <div id="graph-canvas" class="graph-canvas" role="img" aria-label="Knowledge graph"></div>
    </div>

    <script src="/app/graph/bundle.js?v=${Date.now()}" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Graph', active: 'graph', email: session.email, body })
  );
}
