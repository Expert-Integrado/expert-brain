import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { getVaultStatus } from '../auth/setup.js';
import { listApiKeys } from '../auth/api-keys.js';
import { flashKvKey } from './api-keys.js';

// Template padrão pra primeira visita — placeholders entre [colchetes] que o
// usuário substitui pelo próprio contexto. O texto fica editável inline em
// /app/config e persiste na tabela `meta` com a chave `personalization_prompt`.
const DEFAULT_PREFS_BLOCK = `Expert Brain está conectado como servidor MCP — é meu grafo de conhecimento pessoal cross-domain.

Contexto: sou [seu nome]. Trabalho com [suas áreas/domínios principais — ex: gestão, vendas, educação, IA aplicada].

Comportamento esperado:
- Antes de responder perguntas conceituais ou estratégicas, consulte o vault em busca de analogias — especialmente de domínios diferentes do tema da conversa.
- Quando eu compartilhar uma ideia, decisão ou aprendizado que vale preservar, ofereça salvar. Se eu concordar: atomize em um conceito por nota, escolha um domínio específico, varra outros domínios em busca de analogias estruturais, e crie conexões com justificativa do mecanismo compartilhado.
- Quando eu perguntar sobre algo que pode estar no vault, prefira buscar lá antes de responder do zero.
- Não use o vault em tarefas operacionais (código, debug, tarefas do dia a dia) — só para ideias, insights, decisões e aprendizados que valem ser reencontrados no futuro.`;

const PREFS_META_KEY = 'personalization_prompt';
const PREFS_MAX_LEN = 8000;

async function getPersonalizationPrompt(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(PREFS_META_KEY)
    .first<{ value: string }>();
  return row?.value ?? DEFAULT_PREFS_BLOCK;
}

export async function handleConfigPrefsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const prompt = String(form.get('prompt') ?? '').trim();
  if (!prompt) return htmlResponse('Prompt não pode ficar vazio', 400);
  if (prompt.length > PREFS_MAX_LEN) {
    return htmlResponse(`Prompt longo demais (máx ${PREFS_MAX_LEN} caracteres)`, 400);
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(PREFS_META_KEY, prompt)
    .run();
  return new Response(null, { status: 302, headers: { location: '/app/config#prefs' } });
}

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

  const prefsPrompt = await getPersonalizationPrompt(env);
  const stats = await getVaultStatus(env);
  const lastWriteStr = stats.lastWrite
    ? new Date(stats.lastWrite).toLocaleString('pt-BR')
    : 'Nunca';

  const badge = stats.connected
    ? `<span class="badge-pill badge-ok">● Claude conectado</span>`
    : `<span class="badge-pill badge-warn">○ Aguardando — conecte no passo 1 abaixo</span>`;

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
    ? `<div class="key-flash">
         <h2>Chave criada — copie agora</h2>
         <p>Essa é a única vez que a chave completa aparece. Clique no campo pra selecionar tudo e Ctrl+C.</p>
         <input type="text" readonly class="key-flash-value" value="${esc(justCreatedKey)}">
       </div>`
    : '';

  const body = `
    <div class="page-header">
      <h1>Configurações ${badge}</h1>
    </div>
    <p class="config-subtitle">Dois passos pra ligar seu Expert Brain ao Claude. Só o passo 1 é obrigatório.</p>

    <div class="card card-step">
      <h2 class="step-head"><span class="step-num">1</span>URL do servidor MCP</h2>
      <p class="config-hint">Cole no Claude pra conectar seu vault — esse é o único passo obrigatório.</p>
      <p style="color:var(--text-dim)">No Claude → <strong>Customize → Conectores → Adicionar Conector Personalizado</strong>, cole esta URL:</p>
      <div class="row">
        <div id="mcp-url" class="url-box">/mcp</div>
        <button type="button" data-copy="mcp-url">Copiar URL</button>
      </div>
      <p class="callout-info">
        <strong>Não precisa de API key.</strong> Ao conectar, o Claude abre o navegador pedindo login — use o <em>mesmo e-mail e senha</em> deste painel. A autenticação é OAuth 2.1 e o token é guardado automaticamente pelo Claude.
      </p>
    </div>

    <div class="card card-step" id="prefs">
      <h2 class="step-head"><span class="step-num">2</span>Prompt de personalização</h2>
      <p class="config-hint">O texto que faz o Claude usar o vault sozinho em toda conversa — não só quando o tema é óbvio.</p>
      <p style="color:var(--text-dim)">Edite com seu nome e suas áreas, clique <strong>Salvar</strong>, e cole em <em>Claude → <strong>Configurações → Geral → Instruções para o Claude</strong></em>.</p>
      <form method="post" action="/app/config/prefs">
        <textarea id="prefs-block" name="prompt" rows="14" maxlength="${PREFS_MAX_LEN}" class="prefs-textarea">${esc(prefsPrompt)}</textarea>
        <div class="row" style="margin-top:10px;gap:8px">
          <button type="submit" class="btn-primary">Salvar</button>
          <button type="button" data-copy="prefs-block">Copiar prompt</button>
        </div>
      </form>
    </div>

    ${createdBanner}

    <details class="disclosure-advanced" id="api-keys"${justCreatedKey ? ' open' : ''}>
      <summary>
        <span class="adv-title">Para desenvolvedores e automações</span>
        <span class="adv-sub">Claude Code (CLI), chaves de API para scripts, agentes e containers — opcional</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <h3>Claude Code (CLI)</h3>
          <p>Conecta o Expert Brain ao Claude Code pelo terminal.</p>
          <div class="row">
            <div id="code-add" class="url-box">claude mcp add --transport http expert-brain &lt;URL&gt;</div>
            <button type="button" data-copy="code-add">Copiar comando</button>
          </div>
        </div>
        <div class="adv-section">
          <h3>O que são chaves de API</h3>
          <p>Tokens pessoais de longa duração pro servidor MCP. Use quando o cliente não consegue fazer refresh OAuth (agentes, scripts, containers). Envie no header <code>Authorization: Bearer eb_pat_...</code> em <code>/mcp</code>. Não expiram — revogue a chave pra matar o acesso na hora.</p>
        </div>
        <div class="adv-section">
          <h3>Criar nova chave</h3>
          <form method="post" action="/app/api-keys/create">
            <label>Nome (pra você lembrar onde usa)
              <input type="text" name="name" required maxlength="80" placeholder="hermes-vps / openclaw-asafe / ..." class="input-text">
            </label>
            <button type="submit" class="btn-primary" style="margin-top:12px">Criar chave</button>
          </form>
        </div>
        <div class="adv-section">
          <h3>Suas chaves</h3>
          ${keys.length === 0 ? '<p style="color:var(--text-dim)">Nenhuma chave ainda.</p>' : `
          <table class="keys-table">
            <thead><tr>
              <th>Nome</th><th>Prefixo</th><th>Status</th><th>Criada em</th><th>Último uso</th><th></th>
            </tr></thead>
            <tbody>${keyRows}</tbody>
          </table>`}
        </div>
      </div>
    </details>

    <div class="vault-stats-foot">
      <h3>Seu vault até agora</h3>
      <div class="vault-stat-grid">
        <div class="stat-pill"><span class="v">${stats.notes}</span><span class="k">Notas</span></div>
        <div class="stat-pill"><span class="v">${stats.edges}</span><span class="k">Conexões</span></div>
        <div class="stat-pill"><span class="v">${esc(lastWriteStr)}</span><span class="k">Última escrita</span></div>
        <div class="stat-pill"><span class="v">${stats.clients}</span><span class="k">Clientes OAuth</span></div>
        <div class="stat-pill"><span class="v">${stats.tokens}</span><span class="k">Tokens ativos</span></div>
      </div>
      ${lastWriteStr === 'Nunca' ? '<p class="empty-hint">Salve sua primeira nota pelo Claude pra ver o grafo crescer.</p>' : ''}
      <p class="links"><a href="/app/graph">Ver grafo</a> · <a href="/app/notes">Ver notas</a></p>
    </div>

    <script src="/app/config/bundle.js" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Configurações', active: 'config', email: session.email, body, sidebarCollapsed: sidebarCollapsedFromReq(req) })
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
