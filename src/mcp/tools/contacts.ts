import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, canSeePrivate } from '../helpers.js';

// Leitura do vault de CONTATOS (Expert Contacts) DENTRO do MCP do Brain — um MCP
// só pra notas + tasks + contatos. Vai pelo service binding CONTACTS + Bearer
// (CONTACTS_PROXY_TOKEN, que o worker do Contacts aceita só pra GET/leitura).
//
// Privacidade (spec 50-console-v2/61): o token do proxy SEMPRE pôde ler 100% do
// contacts. O header X-Include-Private é como o Brain PROPAGA o escopo do SEU caller
// (o PAT/sessão que chamou a tool) downstream — auto-restrição por request. Só quando
// `includePrivate` (caller com escopo `private` ou sessão OAuth do dono) o contacts
// devolve entidades/eventos privados; sem o header ele filtra (fail-closed do lado de lá).
async function callContacts(env: Env, path: string, includePrivate = false): Promise<{ ok: boolean; status: number; data: any }> {
  if (!env.CONTACTS || !env.CONTACTS_PROXY_TOKEN) {
    return { ok: false, status: 503, data: { error: 'contacts binding/token not configured' } };
  }
  const headers: Record<string, string> = { authorization: `Bearer ${env.CONTACTS_PROXY_TOKEN}` };
  if (includePrivate) headers['x-include-private'] = '1';
  const res = await env.CONTACTS.fetch(new Request(`https://contacts${path}`, { method: 'GET', headers }));
  let data: any = null;
  try { data = await res.json(); } catch { data = { error: 'invalid json from contacts' }; }
  return { ok: res.ok, status: res.status, data };
}

export function registerContactsTools(server: any, env: Env, auth: AuthContext): void {
  // Escopo do caller (spec 61 / 31): sessão OAuth do dono OU PAT com `private` no CSV
  // veem contatos privados; PAT sem escopo NÃO. Mesma regra das notas privadas.
  const seePrivate = canSeePrivate(auth);
  // ── list_contacts ────────────────────────────────────────────────
  server.registerTool(
    'list_contacts',
    {
      description: `Lists contacts from the Contacts vault (people and companies). Optional filters: kind ('person' | 'company'), category (cliente|lead|lead-perdido|aluno|parceiro|fornecedor|equipe|familia|pessoal|network|outro), has_phone, limit (default 100, max 1000), offset (pagination). Raw imports (name = phone number, no letters) are HIDDEN by default — pass include_raw:true to see them (used by the audit/cleanup). Returns id, name, phone, email, role, company, sector, category. Read-only. To EXPORT all contacts, page with limit+offset (e.g. limit 1000, offset 0, 1000, 2000...). Use search_contacts for a semantic/name lookup; get_contact_by_phone for an EXACT phone match; get_contact for one contact's detail + connections.`,
      inputSchema: {
        kind: z.enum(['person', 'company']).optional(),
        category: z.string().optional().describe('Segment filter: cliente|lead|lead-perdido|aluno|parceiro|fornecedor|equipe|familia|pessoal|network|outro.'),
        has_phone: z.boolean().optional().describe('Only contacts that have a phone.'),
        include_raw: z.boolean().optional().describe('Include raw imports (name = phone number, no letters). Default false — they are hidden.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 100, max 1000.'),
        offset: z.number().int().min(0).optional().describe('Pagination offset (default 0). Page with limit+offset to export everything.'),
      },
      annotations: { title: 'List contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { kind?: string; category?: string; has_phone?: boolean; include_raw?: boolean; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (input.kind) qs.set('kind', input.kind);
      if (input.category) qs.set('category', input.category);
      if (input.has_phone) qs.set('has_phone', 'true');
      if (input.include_raw) qs.set('include_raw', 'true');
      qs.set('limit', String(input.limit ?? 100));
      if (typeof input.offset === 'number') qs.set('offset', String(input.offset));
      const r = await callContacts(env, `/list_entities?${qs.toString()}`, seePrivate);
      if (!r.ok) return toolError(`Contacts read failed (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
      return toolSuccess({ count: r.data.count, contacts: r.data.results });
    }) as any
  );

  // ── search_contacts ──────────────────────────────────────────────
  server.registerTool(
    'search_contacts',
    {
      description: `Semantic + name search over the Contacts vault. Pass a query (a name, company, role, or free text like "advogado em SP"). Optional filters: kind ('person'|'company'), category (cliente|lead|lead-perdido|aluno|parceiro|fornecedor|equipe|familia|pessoal|network|outro). Raw imports (name = phone number) are hidden by default — pass include_raw:true to see them. Returns matching contacts. Read-only.`,
      inputSchema: {
        query: z.string().min(1).describe('Name, company, role, or free-text.'),
        kind: z.enum(['person', 'company']).optional(),
        category: z.string().optional().describe('Segment filter: cliente|lead|lead-perdido|aluno|parceiro|fornecedor|equipe|familia|pessoal|network|outro.'),
        include_raw: z.boolean().optional().describe('Include raw imports (name = phone number). Default false.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      },
      annotations: { title: 'Search contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { query: string; kind?: string; category?: string; include_raw?: boolean; limit?: number }) => {
      const qs = new URLSearchParams({ q: input.query, limit: String(input.limit ?? 20) });
      if (input.kind) qs.set('kind', input.kind);
      if (input.category) qs.set('category', input.category);
      if (input.include_raw) qs.set('include_raw', 'true');
      const r = await callContacts(env, `/recall_entity?${qs.toString()}`, seePrivate);
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
      const r = await callContacts(env, `/entities/${encodeURIComponent(input.id)}`, seePrivate);
      if (!r.ok) return toolError(`Contact '${input.id}' not found (HTTP ${r.status}).`);
      return toolSuccess(r.data);
    }) as any
  );

  // ── get_contact_by_phone ─────────────────────────────────────────
  server.registerTool(
    'get_contact_by_phone',
    {
      description: `Deterministic EXACT lookup of a contact by phone (handles the BR mobile 9th digit). Unlike search_contacts (semantic/approximate), this returns the EXACT phone match — use it to cross-reference or dedupe by phone. Accepts +, spaces and dashes. Returns { match, results, variants }.`,
      inputSchema: { phone: z.string().min(8).describe('Phone E.164 without + (e.g. 5511996647492).') },
      annotations: { title: 'Get contact by phone', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { phone: string }) => {
      const r = await callContacts(env, `/get_contact_by_phone?phone=${encodeURIComponent(input.phone)}`, seePrivate);
      if (!r.ok) return toolError(`Phone lookup failed (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
      return toolSuccess(r.data);
    }) as any
  );
}
