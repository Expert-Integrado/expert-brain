import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse } from './render.js';
import { getVaultStatus } from '../auth/setup.js';

const PREFS_BLOCK = `Mind Vault is connected as an MCP server. When I am discussing
concepts, ideas, insights, decisions, or learnings — across any
domain — proactively think in terms of the latticework method:
- Check the vault via MindVault:recall before relying only on your
  own knowledge, especially for cross-domain analogies.
- When I share something worth remembering, offer to save it and,
  if I agree, atomize it into one concept per note, tag it with
  specific domain(s), sweep other domains for analogies, and
  create edges with substantive why justifications.
- When I ask about a topic that might be in the vault, prefer
  recall + expand over generic answers. The value of the vault
  comes from being read, not just written.
Follow the using-mind-vault skill for the full method.`;

export async function handleConfigPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const stats = await getVaultStatus(env);
  const lastWriteStr = stats.lastWrite
    ? new Date(stats.lastWrite).toLocaleString('en-US')
    : 'Never';

  const badge = stats.connected
    ? `<span class="badge-pill badge-ok">● Claude connected</span>`
    : `<span class="badge-pill badge-warn">○ Waiting for Claude connection</span>`;

  const body = `
    <div class="page-header">
      <h1>Config ${badge}</h1>
    </div>

    <div class="card">
      <h2>Vault status</h2>
      <p><strong>Notes:</strong> ${stats.notes} &nbsp;·&nbsp; <strong>Edges:</strong> ${stats.edges} &nbsp;·&nbsp; <strong>Last write:</strong> ${esc(lastWriteStr)}</p>
      <p style="color:var(--text-dim);font-size:13px"><strong>Registered OAuth clients:</strong> ${stats.clients} &nbsp;·&nbsp; <strong>Active tokens:</strong> ${stats.tokens}</p>
    </div>

    <div class="card">
      <h2>1. MCP server URL</h2>
      <p style="color:var(--text-dim)">Paste this URL into Claude Desktop / Web → Settings → Connectors → Add custom connector.</p>
      <div class="row">
        <div id="mcp-url" class="url-box">/mcp</div>
        <button type="button" data-copy="mcp-url">Copy URL</button>
      </div>
      <details style="margin-top:12px">
        <summary style="cursor:pointer;color:var(--text-dim)">Using Claude Code (CLI)?</summary>
        <div class="row" style="margin-top:8px">
          <div id="code-add" class="url-box">claude mcp add --transport http mind-vault &lt;URL&gt;</div>
          <button type="button" data-copy="code-add">Copy command</button>
        </div>
      </details>
      <p style="margin-top:16px;padding:12px 14px;background:rgba(140,200,255,0.07);border:1px solid rgba(140,200,255,0.18);border-radius:8px;font-size:13px;color:var(--text-dim)">
        <strong style="color:var(--accent-cyan)">No API key needed.</strong> When Claude connects to this URL, it opens a browser window asking you to log in — use the <em>same email and passphrase</em> you use to access this dashboard. Authentication is OAuth 2.1, the token is stored by Claude automatically.
      </p>
    </div>

    <div class="card">
      <h2>2. Skill: <code>using-mind-vault</code></h2>
      <p style="color:var(--text-dim)">Download the ZIP and install it in your Claude client. The skill teaches the latticework method — atomize the concept, cross-domain sweep, edge discipline with a concrete <em>why</em>.</p>
      <p><a href="/skill/using-mind-vault.zip" download><button type="button">⬇ Download using-mind-vault.zip</button></a></p>
      <p style="color:var(--text-dim);font-size:12px"><strong>Claude Code:</strong> extract to <code>~/.claude/skills/</code> · <strong>Desktop / Web:</strong> Settings → Skills → Import</p>
    </div>

    <div class="card">
      <h2>3. Personalization prompt</h2>
      <p style="color:var(--text-dim)">Paste into <em>Claude → Settings → Personalization → Custom instructions</em> to activate the latticework behavior proactively in every conversation, not just when the topic is obvious.</p>
      <pre id="prefs-block">${esc(PREFS_BLOCK)}</pre>
      <button type="button" data-copy="prefs-block">Copy prompt</button>
    </div>

    <script src="/app/config/bundle.js" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Config', active: 'config', email: session.email, body })
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
  if (codeEl) codeEl.textContent = 'claude mcp add --transport http mind-vault ' + url;

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
      btn.textContent = ok ? 'Copied ✓' : 'Select + Ctrl+C';
      setTimeout(function () { btn.textContent = original; }, 1800);
    });
  });
})();
`;
}
