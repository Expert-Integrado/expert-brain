import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse } from './render.js';
import { getVaultStatus } from '../auth/setup.js';
import { listApiKeys } from '../auth/api-keys.js';
import { flashKvKey } from './api-keys.js';

const PREFS_BLOCK = `Expert Brain está conectado como servidor MCP — é meu grafo de conhecimento pessoal cross-domain.

Contexto: sou Eric Luciano, CEO da Expert Integrado. Trabalho com IA aplicada, vendas, gestão, educação, liderança e empreendedorismo.

Comportamento esperado:
- Antes de responder perguntas conceituais ou estratégicas, consulte o vault em busca de analogias — especialmente de domínios diferentes do tema da conversa.
- Quando eu compartilhar uma ideia, decisão ou aprendizado que vale preservar, ofereça salvar. Se eu concordar: atomize em um conceito por nota, escolha um domínio específico, varra outros domínios em busca de analogias estruturais, e crie conexões com justificativa do mecanismo compartilhado.
- Quando eu perguntar sobre algo que pode estar no vault, prefira buscar lá antes de responder do zero.
- Não use o vault em tarefas operacionais (código, debug, tarefas do dia a dia) — só para ideias, insights, decisões e aprendizados que valem ser reencontrados no futuro.`;

export async function handleConfigPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const url = new URL(req.url);
  // M6 fix: a chave plaintext NÃO chega mais via query param. /app/api-keys/create
  // grava em KV com TTL curto e redireciona com um id opaco; aqui consumimos e
  // deletamos (single-use). Sem fallback pra ?new=: redirects em voo no momento
  // do deploy perdem a exibição da chave, mas o aluno só precisa recriar — bem
  // melhor do que continuar vazando a chave no histórico do browser.
  const flash = url.searchParams.get('flash');
  let justCreatedKey: string | null = null;
  if (flash && /^[a-f0-9]{32}$/.test(flash)) {
    const key = flashKvKey(flash);
    const value = await env.OAUTH_KV.get(key);
    if (value) {
      justCreatedKey = value;
      await env.OAUTH_KV.delete(key);
    }
  }

  const stats = await getVaultStatus(env);
  const lastWriteStr = stats.lastWrite
    ? new Date(stats.lastWrite).toLocaleString('pt-BR')
    : 'Nunca';

  const badge = stats.connected
    ? `<span class="badge-pill badge-ok">● Claude conectado</span>`
    : `<span class="badge-pill badge-warn">○ Aguardando conexão do Claude</span>`;

  // API Keys — integrado dentro de Config (antes era page separada /app/api-keys).
  const keys = await listApiKeys(env, session.email);
  const keyRows = keys
    .map((k) => {
      const created = new Date(k.created_at).toLocaleString('pt-BR');
      const lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleString('pt-BR') : '—';
      const revokeBtn = `<form method="post" action="/app/api-keys/revoke" style="display:inline">
             <input type="hidden" name="id" value="${esc(k.id)}">
             <button type="submit" class="btn-danger">Excluir</button>
           </form>`;
      return `<tr>
        <td><strong>${esc(k.name)}</strong></td>
        <td><code>${esc(k.prefix)}…</code></td>
        <td><span class="badge-pill badge-ok">● ativa</span></td>
        <td>${esc(created)}</td>
        <td>${esc(lastUsed)}</td>
        <td>${revokeBtn}</td>
      </tr>`;
    })
    .join('');

  const createdBanner = justCreatedKey
    ? `<div class="card" style="border:1px solid #5a8a5a;background:#1a2a1a">
         <h2>Chave criada — copie agora</h2>
         <p style="color:var(--text-dim)">Essa é a única vez que a chave completa aparece. Clique no campo pra selecionar tudo e Ctrl+C.</p>
         <input type="text" readonly value="${esc(justCreatedKey)}" onclick="this.select()" style="width:100%;padding:10px;background:#0f1a0f;color:#9f9;border:1px solid #2a4a2a;border-radius:4px;font-family:monospace;font-size:13px">
       </div>`
    : '';

  const body = `
    <div class="page-header">
      <h1>Configurações ${badge}</h1>
    </div>

    <div class="card">
      <h2>Status do vault</h2>
      <p><strong>Notas:</strong> ${stats.notes} &nbsp;·&nbsp; <strong>Conexões:</strong> ${stats.edges} &nbsp;·&nbsp; <strong>Última escrita:</strong> ${esc(lastWriteStr)}</p>
      <p style="color:var(--text-dim);font-size:13px"><strong>Clientes OAuth registrados:</strong> ${stats.clients} &nbsp;·&nbsp; <strong>Tokens ativos:</strong> ${stats.tokens}</p>
    </div>

    <div class="card">
      <h2>1. URL do servidor MCP</h2>
      <p style="color:var(--text-dim)">Cole essa URL no Claude Desktop / Web → Settings → Connectors → Add custom connector.</p>
      <div class="row">
        <div id="mcp-url" class="url-box">/mcp</div>
        <button type="button" data-copy="mcp-url">Copiar URL</button>
      </div>
      <details style="margin-top:12px">
        <summary style="cursor:pointer;color:var(--text-dim)">Usando Claude Code (CLI)?</summary>
        <div class="row" style="margin-top:8px">
          <div id="code-add" class="url-box">claude mcp add --transport http expert-brain &lt;URL&gt;</div>
          <button type="button" data-copy="code-add">Copiar comando</button>
        </div>
      </details>
      <p style="margin-top:16px;padding:12px 14px;background:rgba(140,200,255,0.07);border:1px solid rgba(140,200,255,0.18);border-radius:8px;font-size:13px;color:var(--text-dim)">
        <strong style="color:var(--accent-cyan)">Não precisa de API key.</strong> Quando o Claude conectar nessa URL, abre uma aba do navegador pedindo login — use o <em>mesmo e-mail e senha</em> que você usa pra acessar este painel. A autenticação é OAuth 2.1 e o token é armazenado automaticamente pelo Claude.
      </p>
    </div>

    <div class="card">
      <h2>2. Prompt de personalização</h2>
      <p style="color:var(--text-dim)">Cole em <em>Claude → Settings → Personalization → Custom instructions</em> pra ativar o comportamento latticework de forma proativa em toda conversa, não só quando o tema é óbvio.</p>
      <pre id="prefs-block">${esc(PREFS_BLOCK)}</pre>
      <button type="button" data-copy="prefs-block">Copiar prompt</button>
    </div>

    <h2 id="api-keys" style="margin-top:40px;margin-bottom:14px">Chaves de API</h2>

    ${createdBanner}

    <div class="card">
      <h2>O que são chaves de API?</h2>
      <p style="color:var(--text-dim)">Tokens pessoais de longa duração pro servidor MCP. Use quando o cliente não consegue fazer refresh OAuth (agentes, scripts, containers). Envie no header <code>Authorization: Bearer eb_pat_...</code> em <code>/mcp</code>.</p>
      <p style="color:var(--text-dim)">Não expiram. Revogue a chave pra matar o acesso na hora.</p>
    </div>

    <div class="card">
      <h2>Criar nova chave</h2>
      <form method="post" action="/app/api-keys/create">
        <label>Nome (pra você lembrar onde usa)
          <input type="text" name="name" required maxlength="80" placeholder="hermes-vps / openclaw-asafe / ..." style="width:100%;padding:8px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:4px">
        </label>
        <button type="submit" style="margin-top:12px">Criar chave</button>
      </form>
    </div>

    <div class="card">
      <h2>Suas chaves</h2>
      ${keys.length === 0 ? '<p style="color:var(--text-dim)">Nenhuma chave ainda.</p>' : `
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;color:var(--text-dim);font-size:13px">
          <th style="padding:8px">Nome</th><th style="padding:8px">Prefixo</th><th style="padding:8px">Status</th>
          <th style="padding:8px">Criada em</th><th style="padding:8px">Último uso</th><th style="padding:8px"></th>
        </tr></thead>
        <tbody>${keyRows}</tbody>
      </table>`}
    </div>

    <script src="/app/config/bundle.js" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Configurações', active: 'config', email: session.email, body })
  );
}

// Inline JS for the config page: fills the MCP URL with the current origin and
// wires up copy buttons. Served as /app/config/bundle.js so it respects the
// strict script-src 'self' CSP.
export function configPageScript(): string {
  return `(function () {
  var url = location.origin + '/mcp';
  var urlEl = document.getElementById('mcp-url');
  if (urlEl) urlEl.textContent = url;
  var codeEl = document.getElementById('code-add');
  if (codeEl) codeEl.textContent = 'claude mcp add --transport http expert-brain ' + url;

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
      var text = (el.textContent || '').trim();
      var ok = await copyText(text);
      var original = btn.textContent;
      btn.textContent = ok ? 'Copiado ✓' : 'Selecione + Ctrl+C';
      setTimeout(function () { btn.textContent = original; }, 1800);
    });
  });
})();
`;
}
