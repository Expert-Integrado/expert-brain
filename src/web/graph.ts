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
         a 948×836 box with empty space to its right. */
      .main:has(#graph-canvas) { max-width: none; width: auto; padding: 0; }
    </style>
    <div style="position:relative;height:100vh;">
      <div id="graph-overlay" style="position:absolute;top:16px;left:16px;z-index:10;background:rgba(10,6,24,0.75);backdrop-filter:blur(8px);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:12px;color:var(--text-dim);pointer-events:none;">
        <div id="graph-count">Loading…</div>
        <div style="margin-top:6px;display:flex;gap:10px;align-items:center;">
          <span style="display:inline-block;width:16px;border-top:2px solid #b48cff;"></span> explicit
          <span style="display:inline-block;width:16px;border-top:2px solid #8cc8ff;opacity:0.6;margin-left:6px;"></span> similar
        </div>
      </div>
      <div id="graph-canvas" style="position:absolute;inset:0;"></div>
    </div>
    <script src="/app/graph/bundle.js" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Graph', active: 'graph', email: session.email, body })
  );
}
