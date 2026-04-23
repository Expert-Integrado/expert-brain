import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse } from './render.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../auth/api-keys.js';

export async function handleApiKeysPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const url = new URL(req.url);
  const justCreated = url.searchParams.get('new');

  const keys = await listApiKeys(env, session.email);
  const rows = keys
    .map((k) => {
      const created = new Date(k.created_at).toLocaleString('en-US');
      const lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleString('en-US') : '—';
      const revokeBtn = `<form method="post" action="/app/api-keys/revoke" style="display:inline">
             <input type="hidden" name="id" value="${esc(k.id)}">
             <button type="submit" class="btn-danger">Delete</button>
           </form>`;
      return `<tr>
        <td><strong>${esc(k.name)}</strong></td>
        <td><code>${esc(k.prefix)}…</code></td>
        <td><span class="badge-pill badge-ok">● active</span></td>
        <td>${esc(created)}</td>
        <td>${esc(lastUsed)}</td>
        <td>${revokeBtn}</td>
      </tr>`;
    })
    .join('');

  const createdBanner = justCreated
    ? `<div class="card" style="border:1px solid #5a8a5a;background:#1a2a1a">
         <h2>Key created — save it now</h2>
         <p style="color:var(--text-dim)">This is the only time the full key is shown. Click the field to select all, then Ctrl+C / Cmd+C.</p>
         <input type="text" readonly value="${esc(justCreated)}" onclick="this.select()" style="width:100%;padding:10px;background:#0f1a0f;color:#9f9;border:1px solid #2a4a2a;border-radius:4px;font-family:monospace;font-size:13px">
       </div>`
    : '';

  const body = `
    <div class="page-header"><h1>API Keys</h1></div>

    ${createdBanner}

    <div class="card">
      <h2>What are API keys?</h2>
      <p style="color:var(--text-dim)">Long-lived personal access tokens for the MCP server. Use these when your client can't do OAuth refresh (agents, scripts, containers). Send them in the <code>Authorization: Bearer eb_pat_...</code> header on <code>/mcp</code>.</p>
      <p style="color:var(--text-dim)">They never expire. Revoke a key to kill it instantly.</p>
    </div>

    <div class="card">
      <h2>Create new key</h2>
      <form method="post" action="/app/api-keys/create">
        <label>Name (so you remember where it's used)
          <input type="text" name="name" required maxlength="80" placeholder="hermes-vps / openclaw-asafe / ..." style="width:100%;padding:8px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:4px">
        </label>
        <button type="submit" style="margin-top:12px">Create key</button>
      </form>
    </div>

    <div class="card">
      <h2>Your keys</h2>
      ${keys.length === 0 ? '<p style="color:var(--text-dim)">No keys yet.</p>' : `
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;color:var(--text-dim);font-size:13px">
          <th style="padding:8px">Name</th><th style="padding:8px">Prefix</th><th style="padding:8px">Status</th>
          <th style="padding:8px">Created</th><th style="padding:8px">Last used</th><th style="padding:8px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`}
    </div>

  `;

  return htmlResponse(renderShell({ title: 'API Keys', active: 'api-keys', email: session.email, body }));
}

export async function handleApiKeyCreate(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const name = String(form.get('name') ?? '').trim().slice(0, 80);
  if (!name) return htmlResponse('Name required', 400);
  const { plainKey } = await createApiKey(env, session.email, name);
  return new Response(null, {
    status: 302,
    headers: { location: `/app/api-keys?new=${encodeURIComponent(plainKey)}` },
  });
}

export async function handleApiKeyRevoke(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id required', 400);
  await revokeApiKey(env, session.email, id);
  return new Response(null, { status: 302, headers: { location: '/app/api-keys' } });
}
