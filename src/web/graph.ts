import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse } from './render.js';

export async function handleGraphPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const body = `
    <style>
      /* soft radial halo behind the whole canvas instead of per-pixel drop-shadow
         (drop-shadow compounds in dense clusters and turns nodes black) */
      #graph-canvas::before {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(ellipse 60% 50% at 50% 50%, rgba(180, 140, 255, 0.18), transparent 70%);
        pointer-events: none;
      }
      #graph-canvas .sigma-labels { text-shadow: 0 1px 2px rgba(8, 5, 26, 0.95), 0 0 8px rgba(8, 5, 26, 0.9); }
      /* Escape .main's max-width:980px + padding on this page only, so Sigma
         gets the full viewport next to the sidebar instead of rendering into
         a 948x836 box with empty space to its right. */
      .main:has(#graph-canvas) { max-width: none; width: auto; padding: 0; }
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
          <button class="graph-reset-btn" data-graph-action="reset-filters" title="Clear all filters">reset</button>
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
        </div>

        <div class="graph-legend-line">
          <span class="legend-swatch swatch-explicit"></span> explicit
          <span class="legend-swatch swatch-similar"></span> similar
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

    <script src="/app/graph/bundle.js" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Graph', active: 'graph', email: session.email, body })
  );
}
