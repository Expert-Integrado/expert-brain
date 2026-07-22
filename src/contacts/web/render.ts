// Resposta HTML com os headers de segurança do Console (CSP, anti-clickjacking etc).
// Port enxuto do render.ts do Brain: na Fase 0 só precisamos do helper htmlResponse.
// A casca do grafo (shell + canvas + painel) é responsabilidade do WS-1
// (src/web/console-page.ts) e não entra aqui.
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Google Fonts liberado em style-src/font-src pra Poppins/Manrope carregarem.
      // O resto fica 'self'-only. frame-ancestors 'none' + X-Frame-Options: DENY
      // bloqueiam clickjacking mesmo em browsers que ignoram um dos dois.
      'content-security-policy':
        "default-src 'self'; " +
        "script-src 'self'; " +
        "worker-src 'self'; " +
        "manifest-src 'self'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    },
  });
}
