// Helper compartilhado de fetch pros clients do app (/app/*).
// - Sempre manda `accept: application/json` (a menos que o chamador já tenha
//   setado outro accept), pra requireSession() no servidor devolver 401 JSON
//   em vez de 302 pra /app/login quando a sessão expirou.
// - Em 401, redireciona pro login com `next` apontando pra página atual e
//   lança pra interromper o fluxo do chamador (evita "sucesso falso" — ver
//   specs/20-frontend/21-csp-botoes-mortos-e-sessao-expirada.md).
export async function appFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  const res = await fetch(input, { credentials: 'same-origin', ...init, headers });
  if (res.status === 401) {
    location.href = '/app/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('session expired');
  }
  return res;
}
