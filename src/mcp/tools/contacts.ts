import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, canSeePrivate, type ToolResult } from '../helpers.js';
// Enums canônicos do vault de contatos — importados DIRETO da fonte única
// vendorizada (fusão F6, plano joyful-petting-alpaca). No MCP stdio antigo
// (processo Node separado) esses valores eram cópias inline sincronizadas via GET
// /canon + teste anti-drift; agora, in-process, a importação elimina o drift por
// construção — o /canon e o teste anti-drift do worker antigo morrem junto com o
// stdio. Enum no schema (em vez de string livre) faz typo virar erro de validação
// do SDK listando os aceitos, não um count:0 silencioso lido como "não tem".
import { CONTACT_CATEGORIES, CONN_TYPES, EVENT_KINDS } from '../../contacts/canon.js';

// Kinds de entidade oferecidos no save (subconjunto útil de ENTITY_KINDS pro
// vault de contatos; place/event/other seguem aceitos pelo endpoint, mas ficam
// fora do enum da tool pra não poluir a superfície).
const SAVE_CONTACT_KINDS = ['person', 'company', 'group'] as const;

// Diagnóstico por status (spec 10-backend/23): a mensagem é contrato com o agente —
// 404 = não existe (não re-tentar), 503 = deploy sem o binding/token (avisar o
// usuário, não é dado), 5xx = indisponibilidade transiente (1 retry vale).
function contactsError(action: string, r: { status: number; data: any }): ToolResult {
  if (r.status === 404) {
    return toolError(`${action}: not found (HTTP 404). The contact does not exist in the Contacts vault — do not retry with the same id/phone.`);
  }
  if (r.status === 503) {
    return toolError(
      `${action}: the Contacts vault is not configured in this deploy (HTTP 503 — the contacts module binding or its token is missing). ` +
      `This is a deployment issue, not a data issue. Contacts tools are unavailable here; tell the user instead of retrying.`
    );
  }
  if (r.status >= 500) {
    return toolError(`${action}: the Contacts service is temporarily unavailable (HTTP ${r.status}). Wait a few seconds and retry once. Details: ${JSON.stringify(r.data)}`);
  }
  return toolError(`${action} failed (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
}

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

// ESCRITA no vault de contatos (fusão F6). Diferente do read (callContacts), usa o
// CONTACTS_OWNER_TOKEN (acesso pleno) — os endpoints de escrita de entidade
// (/save_entity, /connect, /event, DELETE, /entities/merge) exigem OWNER_TOKEN do
// lado do módulo; o CONTACTS_WRITE_TOKEN cobre SÓ estado de sync (allowlist), não
// mutação direta. Isto só é possível IN-PROCESS: no cross-worker antigo o Brain
// nunca segurava o OWNER_TOKEN do contacts (por isso as write tools são pós-fusão).
// Sem o token (modo dual / pré-cutover) devolve 503 — as tools ficam inertes até o
// secret existir, e o handler reporta "não configurado" em vez de agir.
async function callContactsWrite(
  env: Env,
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  if (!env.CONTACTS || !env.CONTACTS_OWNER_TOKEN) {
    return { ok: false, status: 503, data: { error: 'contacts module binding/owner token not configured' } };
  }
  const init: RequestInit = { method, headers: { authorization: `Bearer ${env.CONTACTS_OWNER_TOKEN}` } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await env.CONTACTS.fetch(new Request(`https://contacts${path}`, init));
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
        category: z.enum(CONTACT_CATEGORIES).optional().describe('Segment filter.'),
        has_phone: z.boolean().optional().describe('Only contacts that have a phone.'),
        include_raw: z.boolean().optional().describe('Include raw imports (name = phone number, no letters). Default false — they are hidden.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 100, max 1000.'),
        offset: z.number().int().min(0).optional().describe('Pagination offset (default 0). Page with limit+offset to export everything.'),
      },
      annotations: { title: 'List contacts', resource: 'contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      if (!r.ok) return contactsError('Contacts read', r);
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
        category: z.enum(CONTACT_CATEGORIES).optional().describe('Segment filter.'),
        include_raw: z.boolean().optional().describe('Include raw imports (name = phone number). Default false.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      },
      annotations: { title: 'Search contacts', resource: 'contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { query: string; kind?: string; category?: string; include_raw?: boolean; limit?: number }) => {
      const qs = new URLSearchParams({ q: input.query, limit: String(input.limit ?? 20) });
      if (input.kind) qs.set('kind', input.kind);
      if (input.category) qs.set('category', input.category);
      if (input.include_raw) qs.set('include_raw', 'true');
      const r = await callContacts(env, `/recall_entity?${qs.toString()}`, seePrivate);
      if (!r.ok) return contactsError('Contacts search', r);
      return toolSuccess({ query: input.query, results: r.data.results ?? r.data });
    }) as any
  );

  // ── get_contact ──────────────────────────────────────────────────
  server.registerTool(
    'get_contact',
    {
      description: `Full detail of one contact (person or company) by id, including its connections. Get the id from list_contacts/search_contacts. Read-only.`,
      inputSchema: { id: z.string().min(1).describe('Contact entity id.') },
      annotations: { title: 'Get contact', resource: 'contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { id: string }) => {
      const r = await callContacts(env, `/entities/${encodeURIComponent(input.id)}`, seePrivate);
      if (!r.ok) return contactsError(`Contact '${input.id}' lookup`, r);
      return toolSuccess(r.data);
    }) as any
  );

  // ── get_contact_by_phone ─────────────────────────────────────────
  server.registerTool(
    'get_contact_by_phone',
    {
      description: `Deterministic EXACT lookup of a contact by phone (handles the BR mobile 9th digit). Unlike search_contacts (semantic/approximate), this returns the EXACT phone match — use it to cross-reference or dedupe by phone. Accepts +, spaces and dashes. Returns { match, results, variants }.`,
      inputSchema: { phone: z.string().min(8).describe('Phone E.164 without + (e.g. 5511987654321).') },
      annotations: { title: 'Get contact by phone', resource: 'contacts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { phone: string }) => {
      const r = await callContacts(env, `/get_contact_by_phone?phone=${encodeURIComponent(input.phone)}`, seePrivate);
      if (!r.ok) return contactsError('Phone lookup', r);
      return toolSuccess(r.data);
    }) as any
  );

  // ══ ESCRITA (fusão F6) ═══════════════════════════════════════════════════
  // Todas resource:'contacts' + readOnlyHint:false → o scopeGuard as SUPRIME em
  // credencial `read` e `contacts:none` (só full/dono enxerga). delete/merge levam
  // destructiveHint:true. Usam callContactsWrite (OWNER_TOKEN); inertes (503) até o
  // secret CONTACTS_OWNER_TOKEN existir no deploy (pós-cutover).

  // ── save_contact ─────────────────────────────────────────────────────────
  server.registerTool(
    'save_contact',
    {
      description: `Creates or updates a contact in the Contacts vault (person, company or group). Upsert: pass an id to update a known contact; without id, a person dedupes by phone (BR 9th-digit aware) and a company/group by exact name (case-insensitive). Required: name. Optional: kind ('person'|'company'|'group', default person), phone, email, role, company, website, sector, birthday (YYYY-MM-DD), notes_text, category (${CONTACT_CATEGORIES.join('|')}), private (true marks the contact private — ONE-WAY, can only be unmarked in the logged-in console). Returns { id, action: 'created'|'updated' }. Run search_contacts/get_contact_by_phone first to avoid duplicates.`,
      inputSchema: {
        name: z.string().min(1).describe('Display name (required).'),
        kind: z.enum(SAVE_CONTACT_KINDS).optional().describe("Default 'person'."),
        id: z.string().optional().describe('Pass to UPDATE an existing contact by id (from list/search/get).'),
        phone: z.string().optional().describe('Phone (person dedupe key; BR 9th-digit aware).'),
        email: z.string().optional(),
        role: z.string().optional().describe('Job title / role.'),
        company: z.string().optional(),
        website: z.string().optional(),
        sector: z.string().optional(),
        birthday: z.string().optional().describe('YYYY-MM-DD.'),
        notes_text: z.string().optional().describe('Free-text notes about the contact.'),
        category: z.enum(CONTACT_CATEGORIES).optional().describe('Segment filter.'),
        private: z.boolean().optional().describe('true marks private (one-way).'),
      },
      annotations: { title: 'Save contact', resource: 'contacts', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: Record<string, unknown>) => {
      const r = await callContactsWrite(env, 'POST', '/save_entity', input);
      if (!r.ok) return contactsError('Save contact', r);
      return toolSuccess(r.data);
    }) as any
  );

  // ── connect_contacts ───────────────────────────────────────────────────────
  server.registerTool(
    'connect_contacts',
    {
      description: `Creates a connection (edge) between two contacts. Both must already exist (use save_contact first). type is one of: ${CONN_TYPES.join('|')}. strength is 0..1 (how strong the tie is). why must be at least 20 chars explaining the shared context/mechanism (the vault rejects vague edges). Symmetric types (friend, colleague, family, partner_of, competitor_of, peer_tech, interacts_with) dedupe regardless of a/b order — a duplicate returns an error.`,
      inputSchema: {
        a_id: z.string().min(1).describe('First contact id.'),
        b_id: z.string().min(1).describe('Second contact id (must differ from a_id).'),
        type: z.enum(CONN_TYPES).describe('Relationship type.'),
        strength: z.number().min(0).max(1).describe('Tie strength, 0..1.'),
        why: z.string().min(20).describe('At least 20 chars — the shared context/mechanism.'),
      },
      annotations: { title: 'Connect contacts', resource: 'contacts', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { a_id: string; b_id: string; type: string; strength: number; why: string }) => {
      const r = await callContactsWrite(env, 'POST', '/connect', input);
      if (!r.ok) return contactsError('Connect contacts', r);
      return toolSuccess(r.data);
    }) as any
  );

  // ── log_contact_event ──────────────────────────────────────────────────────
  server.registerTool(
    'log_contact_event',
    {
      description: `Logs an interaction/event on a contact's timeline (and bumps last_contacted for met/talked/note/meeting). entity_id is the contact id. kind is one of: ${EVENT_KINDS.join('|')} — the common manual ones are met, talked, meeting, email, message, note. Optional: context (free text — what happened), ts (ISO 8601; defaults to now), private (true = private event). Use this after a call/meeting/message to keep the relationship history.`,
      inputSchema: {
        entity_id: z.string().min(1).describe('Contact id (from list/search/get).'),
        kind: z.enum(EVENT_KINDS).describe('Event kind.'),
        context: z.string().optional().describe('What happened (free text).'),
        ts: z.string().optional().describe('ISO 8601 timestamp; defaults to now.'),
        private: z.boolean().optional().describe('true = private event.'),
      },
      annotations: { title: 'Log contact event', resource: 'contacts', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { entity_id: string; kind: string; context?: string; ts?: string; private?: boolean }) => {
      const r = await callContactsWrite(env, 'POST', '/event', input);
      if (!r.ok) return contactsError('Log contact event', r);
      return toolSuccess(r.data);
    }) as any
  );

  // ── delete_contact ─────────────────────────────────────────────────────────
  server.registerTool(
    'delete_contact',
    {
      description: `HARD-deletes a contact by id — PERMANENT and IRREVERSIBLE (not a soft delete; unlike delete_note there is no restore). Cascades: removes the contact's connections, timeline events, channels and media too. Requires confirm:true. Ask the user before calling. Returns the deleted contact and cascade counts.`,
      inputSchema: {
        id: z.string().min(1).describe('Contact id to delete.'),
        confirm: z.literal(true).describe('Must be true — guards against accidental deletion.'),
      },
      annotations: { title: 'Delete contact', resource: 'contacts', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safeToolHandler(async (input: { id: string }) => {
      const r = await callContactsWrite(env, 'DELETE', `/entities/${encodeURIComponent(input.id)}?confirm=true`);
      if (!r.ok) return contactsError(`Delete contact '${input.id}'`, r);
      return toolSuccess(r.data);
    }) as any
  );

  // ── delete_contact_connection ────────────────────────────────────────────
  server.registerTool(
    'delete_contact_connection',
    {
      description: `Removes ONE connection (edge) between two contacts by the connection's id (get it from get_contact, which lists a contact's connections with their ids). Only the edge is removed — both contacts stay. Requires confirm:true. Returns the deleted edge.`,
      inputSchema: {
        id: z.string().min(1).describe('Connection id (from get_contact).'),
        confirm: z.literal(true).describe('Must be true.'),
      },
      annotations: { title: 'Delete contact connection', resource: 'contacts', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safeToolHandler(async (input: { id: string }) => {
      const r = await callContactsWrite(env, 'DELETE', `/connections/${encodeURIComponent(input.id)}?confirm=true`);
      if (!r.ok) return contactsError(`Delete connection '${input.id}'`, r);
      return toolSuccess(r.data);
    }) as any
  );

  // ── merge_contacts ─────────────────────────────────────────────────────────
  server.registerTool(
    'merge_contacts',
    {
      description: `Merges two DUPLICATE contacts of the SAME kind into one — PERMANENT and IRREVERSIBLE. winner_id keeps its own fields (name never changes) and absorbs the loser's connections, timeline events, media and any fields it was missing (COALESCE — winner wins where it has a value); loser_id is then deleted. Requires confirm:true. Use get_contact_by_phone/search_contacts to find the two ids first. Ask the user before calling.`,
      inputSchema: {
        winner_id: z.string().min(1).describe('The contact that survives (keeps its fields).'),
        loser_id: z.string().min(1).describe('The duplicate that is absorbed and deleted (must differ, same kind).'),
        confirm: z.literal(true).describe('Must be true — destructive and irreversible.'),
      },
      annotations: { title: 'Merge contacts', resource: 'contacts', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safeToolHandler(async (input: { winner_id: string; loser_id: string; confirm: true }) => {
      const r = await callContactsWrite(env, 'POST', '/entities/merge', input);
      if (!r.ok) return contactsError('Merge contacts', r);
      return toolSuccess(r.data);
    }) as any
  );
}
