import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import { esc } from '../util/html.js';
import { fetchContactEntityServerSide } from './contacts-data.js';

// GET /app/contacts/<id> — página própria do contato (spec 50-console-v2/56 §3).
// SSR renderiza só o shell NEBULA + esqueleto (data-contact-id): os 3 dados
// (entity, neighbors, timeline) são hidratados no client
// (src/web/client/contact-page.ts) via fetch nos proxies same-origin já
// existentes (contacts-data.ts). A ÚNICA busca server-side aqui é a checagem de
// existência (fetchContactEntityServerSide) — decide 404 amigável ANTES de
// mandar HTML pro browser (critério de aceite 1); o client refaz o fetch do
// detalhe pra hidratar (pequena duplicação aceita, ver contacts-data.ts).
export async function handleContactPage(req: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const notFoundBody = '<h1>Contato não encontrado</h1><p><a href="/app/contacts">← Voltar pros contatos</a></p>';

  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return htmlResponse(
      await renderShell({
        title: 'Contato não encontrado',
        active: 'contacts',
        email: session.email,
        env,
        body: notFoundBody,
        sidebarCollapsed: sidebarCollapsedFromReq(req),
      }),
      404,
    );
  }

  const check = await fetchContactEntityServerSide(env, id);
  if (check.status === 404 || (check.body && check.body.ok === false && check.body.error === 'entity_not_found')) {
    return htmlResponse(
      await renderShell({
        title: 'Contato não encontrado',
        active: 'contacts',
        email: session.email,
        env,
        body: notFoundBody,
        sidebarCollapsed: sidebarCollapsedFromReq(req),
      }),
      404,
    );
  }
  // Qualquer outro status (200, ou 503 com binding/token não configurados) segue
  // pro shell normal — a hidratação client-side trata o erro sem quebrar a
  // página (mesmo racional aditivo do painel do grafo).

  const body = `
    <style>
      .contact-page { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
      .contact-page-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
      .contact-page-avatar { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background: rgba(255,255,255,0.06); flex-shrink: 0; }
      .contact-page-avatar-fallback { width: 64px; height: 64px; border-radius: 50%; background: rgba(255,255,255,0.06); flex-shrink: 0; }
      .contact-page-name { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
      .contact-page-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .contact-page-actions { display: flex; gap: 8px; margin: 16px 0 24px; flex-wrap: wrap; }
      .contact-page-section { margin-top: 28px; }
      .contact-page-section h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-bottom: 10px; }
      .contact-page-fields { display: grid; gap: 8px; }
      .contact-page-field { display: flex; gap: 8px; font-size: 14px; }
      .contact-page-field dt { opacity: 0.6; min-width: 110px; }
      .contact-page-field dd { margin: 0; }
      .contact-page-vinculos { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
      .contact-page-via-group { margin-bottom: 16px; }
      .contact-page-via-label { font-size: 12px; opacity: 0.6; margin-bottom: 6px; }
      .contact-page-empty { opacity: 0.6; font-size: 14px; }
      .contact-page-warn { font-size: 13px; opacity: 0.65; margin-top: 8px; }
    </style>
    <div class="contact-page" data-contact-id="${esc(id)}">
      <div class="contact-page-loading center-loading" role="status" aria-live="polite">
        <div class="center-loading-spinner" aria-hidden="true"></div>
        <div>Carregando contato...</div>
      </div>
    </div>
  `;

  return htmlResponse(
    await renderShell({
      title: 'Contato',
      active: 'contacts',
      email: session.email,
      env,
      body,
      extraHead: `<script src="/app/contacts/contact-page.bundle.js?v=${assetVersion('contact-page.bundle.js')}" defer></script>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    }),
  );
}
