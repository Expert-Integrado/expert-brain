import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { RELEASES, markLatestReleaseSeen } from './releases-data.js';

// ─────────────── /app/novidades — release notes (spec 50-console-v2/71) ───────────────
// Visitar a página marca a release mais recente como vista (o banner do shell
// some). Superfície de sessão; nenhum caminho público novo.
export async function handleReleasesPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const entries = RELEASES.map(
    (r) => `
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin-bottom:2px">${esc(r.title)}</h2>
      <p style="color:var(--text-dim);font-size:13px;margin-bottom:10px">${esc(r.date)}</p>
      <ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
        ${r.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}
      </ul>
    </div>`
  ).join('');

  const body = `
    <div class="page-header">
      <h1>Novidades</h1>
    </div>
    <p class="config-subtitle">O que mudou nesta instância a cada atualização — a mais recente primeiro.</p>
    ${entries}
  `;

  const html = await renderShell({
    title: 'Novidades',
    active: 'config',
    email: session.email,
    body,
    env,
    sidebarCollapsed: sidebarCollapsedFromReq(req),
  });

  // Marca como vista DEPOIS de montar a página; falha aqui não impede a leitura
  // (o banner apenas reaparece na próxima navegação).
  try {
    await markLatestReleaseSeen(env);
  } catch (err) {
    console.error('handleReleasesPage: falha ao marcar release como vista', err);
  }

  return htmlResponse(html);
}
