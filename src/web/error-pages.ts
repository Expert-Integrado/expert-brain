// Páginas 404/5xx com marca (spec 91-experiencia-premium/97). A spec apontava
// src/web/layout.ts, mas aquele módulo é o layout DO GRAFO (forceAtlas2) — a
// casca de erro vive aqui. Regra de transporte: navegação de browser (accept
// inclui text/html) ganha a página com marca e caminho de volta; request de
// API/fetch mantém o texto puro histórico (contrato de scripts e monitores).
// Sem sessão, sem D1: a casca não pode falhar de novo.

import { esc } from '../util/html.js';
import { FONT_LINKS } from './styles.js';
import { assetVersion } from './asset-version.js';

function wantsHtml(req: Request): boolean {
  return (req.headers.get('accept') ?? '').includes('text/html');
}

// Casca mínima compartilhada: logo, mensagem, botão pro /app. Reusa o styles.css
// (rota pública) + theme-boot (tema certo até na página de erro). Sem shell
// completo de propósito — a sidebar depende de sessão e o erro pode vir antes.
function errorShell(title: string, headline: string, detail: string): string {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Expert Brain</title>
<script src="/app/theme-boot.js?v=1"></script>
${FONT_LINKS}
<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}">
</head><body>
<div class="error-page">
  <div class="error-card">
    <div class="logo"><span class="logo-text">Expert Brain</span></div>
    <h1>${esc(headline)}</h1>
    <p>${detail}</p>
    <a class="btn btn-primary" href="/app">Voltar pro início</a>
    <p class="error-hint">Dica: Ctrl+K busca qualquer nota, task ou contato.</p>
  </div>
</div>
</body></html>`;
}

const ERROR_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
} as const;

export function notFoundResponse(req: Request): Response {
  if (!wantsHtml(req)) return new Response('Não encontrado', { status: 404 });
  return new Response(
    errorShell('Página não encontrada', 'Página não encontrada',
      'Esse endereço não existe (ou não existe mais). O conteúdo pode ter sido movido — a busca encontra.'),
    { status: 404, headers: ERROR_HEADERS },
  );
}

// 5xx com id de correlação: o MESMO id vai pro console.error (log do Worker) e
// pro corpo — o dono cita o id e o log acha a exceção. Nunca vaza stack/mensagem
// da exceção no HTML.
export function internalErrorResponse(req: Request, err: unknown, errorId?: string): Response {
  const id = errorId ?? crypto.randomUUID().slice(0, 8);
  console.error(`internal error [${id}]`, err);
  if (!wantsHtml(req)) {
    return new Response(`Erro interno (id ${id})`, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
  return new Response(
    errorShell('Algo quebrou', 'Algo quebrou do nosso lado',
      `Já ficou registrado com o código <code>${esc(id)}</code>. Recarregue em instantes; se persistir, cite esse código.`),
    { status: 500, headers: ERROR_HEADERS },
  );
}
