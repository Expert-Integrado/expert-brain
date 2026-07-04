// Módulo FOLHA (spec 28): só a string do bundle inline da página /app/config, sem
// nenhuma dependência de runtime do Worker (env, D1, render). scripts/build-bundles.ts
// importa daqui pra hashear o conteúdo em ASSET_HASHES['config.bundle.js'] sem puxar
// o grafo de imports do config.ts. config.ts re-exporta pra não quebrar callers.
//
// Inline JS for the config page: fills the MCP URL with the current origin and
// wires up copy buttons. Served as /app/config/bundle.js so it respects the
// strict script-src 'self' CSP.
export function configPageScript(): string {
  return `(function () {
  var url = location.origin + '/mcp';
  // Pode haver mais de um box de URL (aba "agente local" e aba "sistemas web").
  document.querySelectorAll('.js-mcp-url').forEach(function (el) { el.textContent = url; });
  document.querySelectorAll('.js-code-add').forEach(function (el) {
    el.textContent = 'claude mcp add --transport http expert-brain ' + url;
  });

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }
  document.querySelectorAll('button[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = btn.getAttribute('data-copy');
      var el = document.getElementById(id);
      if (!el) return;
      var text = ('value' in el ? el.value : (el.textContent || '')).trim();
      var ok = await copyText(text);
      var original = btn.textContent;
      btn.textContent = ok ? 'Copiado ✓' : 'Selecione + Ctrl+C';
      setTimeout(function () { btn.textContent = original; }, 1800);
    });
  });

  // Campo da chave recem-criada: selecionar tudo ao focar/clicar. Substitui o
  // onclick="this.select()" inline (bloqueado pela CSP script-src 'self').
  document.querySelectorAll('.key-flash-value').forEach(function (el) {
    el.addEventListener('focus', function () { el.select(); });
    el.addEventListener('click', function () { el.select(); });
  });
})();
`;
}
