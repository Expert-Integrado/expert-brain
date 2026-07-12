// Erro de form sem página morta (spec 91-experiencia-premium/94).
// Dois transportes, um contrato:
// - Client moderno (appFetch manda `accept: application/json`): JSON
//   { ok:false, error, field } com o status do erro — o shell mostra inline/toast.
// - Form nativo sem JS: 303 de volta pra página de origem com ?error= — a página
//   renderiza o banner via formErrorBanner(). NUNCA htmlResponse(texto, 4xx).

import { esc } from '../util/html.js';

const ERROR_MSG_CAP = 300;

export function wantsJson(req: Request): boolean {
  return (req.headers.get('accept') ?? '').includes('application/json');
}

// Destino do fallback: referer same-origin (preserva query/aba onde o usuário
// estava), senão returnTo do handler, senão /app. Hash só existe em returnTo
// (referer não carrega hash) e precisa ficar DEPOIS da query na location.
function fallbackTarget(req: Request, returnTo?: string): URL {
  const origin = new URL(req.url).origin;
  const ref = req.headers.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.origin === origin) return u;
    } catch { /* referer inválido — ignora */ }
  }
  return new URL(returnTo ?? '/app', origin);
}

export interface FormErrorOpts {
  field?: string;
  status?: number;
  returnTo?: string;
}

export function formError(req: Request, message: string, opts: FormErrorOpts = {}): Response {
  const status = opts.status ?? 400;
  if (wantsJson(req)) {
    return new Response(
      JSON.stringify({ ok: false, error: message, field: opts.field ?? null }),
      { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
  const target = fallbackTarget(req, opts.returnTo);
  target.searchParams.delete('error');
  target.searchParams.set('error', message.slice(0, ERROR_MSG_CAP));
  return new Response(null, {
    status: 303,
    headers: { location: target.pathname + target.search + target.hash },
  });
}

// Banner do fallback sem JS — as páginas que recebem POSTs de form chamam isto
// no topo do body com a URL do GET. Escapado e com teto (a mensagem veio da URL).
export function formErrorBanner(url: URL): string {
  const msg = url.searchParams.get('error');
  if (!msg) return '';
  return `<div class="callout-error" role="alert">${esc(msg.slice(0, ERROR_MSG_CAP))}</div>`;
}
