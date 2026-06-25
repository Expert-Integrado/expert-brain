import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';

// Leitura do vault de CONTATOS (Expert Contacts) DENTRO do MCP do Brain — um MCP
// só pra notas + tasks + contatos. Vai pelo service binding CONTACTS + Bearer
// (CONTACTS_PROXY_TOKEN, que o worker do Contacts aceita só pra GET/leitura).
async function callContacts(env: Env, path: string): Promise<{ ok: boolean; status: number; data: any }> {
  if (!env.CONTACTS || !env.CONTACTS_PROXY_TOKEN) {
    return { ok: false, status: 503, data: { error: 'contacts binding/token not configured' } };
  }
  const res = await env.CONTACTS.fetch(new Request(`https://contacts${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${env.CONTACTS_PROXY_TOKEN}` },
  }));
  let data: any = null;
  try { data = await res.json(); } catch { data = { error: 'invalid json from contacts' }; }
  return { ok: res.ok, status: res.status, data };
}

export function registerContactsTools(server: any, env: Env): void {
  // ── list_contacts ────────────────────────────────────────────────
  server.registerTool(
    'list_contacts',
    {
      description: `Lists contacts from the Contacts vault (people and companies). Optional filters: kind ('person' | 'company'), has_phone, limit (default 100). Returns id, name, phone, email, role, company, sector. Read-only. Use search_contacts for a semantic/name lookup; get_contact for one contact's detail + connections.`,
      inputSchema: {
        kind: z.enum(['person', 'company']).optional(),
        has_phone: z.boolean().optional().describe('Only contacts that have a phone.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 100.'),
      },
      annotations: { title: 'List contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { kind?: string; has_phone?: boolean; limit?: number }) => {
      const qs = new URLSearchParams();
      if (input.kind) qs.set('kind', input.kind);
      if (input.has_phone) qs.set('has_phone', 'true');
      qs.set('limit', String(input.limit ?? 100));
      const r = await callContacts(env, `/list_entities?${qs.toString()}`);
      if (!r.ok) return toolError(`Contacts read failed (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
      return toolSuccess({ count: r.data.count, contacts: r.data.results });
    }) as any
  );

  // ── search_contacts ──────────────────────────────────────────────
  server.registerTool(
    'search_contacts',
    {
      description: `Semantic + name search over the Contacts vault. Pass a query (a name, company, role, or free text like "advogado em SP"). Returns matching contacts. Read-only.`,
      inputSchema: {
        query: z.string().min(1).describe('Name, company, role, or free-text.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      },
      annotations: { title: 'Search contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { query: string; limit?: number }) => {
      const qs = new URLSearchParams({ q: input.query, limit: String(input.limit ?? 20) });
      const r = await callContacts(env, `/recall_entity?${qs.toString()}`);
      if (!r.ok) return toolError(`Contacts search failed (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
      return toolSuccess({ query: input.query, results: r.data.results ?? r.data });
    }) as any
  );

  // ── get_contact ──────────────────────────────────────────────────
  server.registerTool(
    'get_contact',
    {
      description: `Full detail of one contact (person or company) by id, including its connections. Get the id from list_contacts/search_contacts. Read-only.`,
      inputSchema: { id: z.string().min(1).describe('Contact entity id.') },
      annotations: { title: 'Get contact', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { id: string }) => {
      const r = await callContacts(env, `/entity/${encodeURIComponent(input.id)}`);
      if (!r.ok) return toolError(`Contact '${input.id}' not found (HTTP ${r.status}).`);
      return toolSuccess(r.data);
    }) as any
  );
}
