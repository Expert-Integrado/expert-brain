// Cliente fino do Google People API (specs/google-contacts-sync.md): leituras do
// sync (grupos + connections paginadas com syncToken) e, pro write-back, leitura
// e PATCH de um contato individual. Erro vira valor tipado — quem decide o que
// fazer (410 EXPIRED → full sync; etag stale → refetch+retry) é a engine.

const API = "https://people.googleapis.com/v1";

// Campos que o sync consome. `metadata` traz o flag deleted das respostas
// incrementais; `memberships` filtra por etiqueta configurada.
const PERSON_FIELDS = "names,phoneNumbers,emailAddresses,birthdays,organizations,memberships,metadata";
const PAGE_SIZE = 200;

import { normalizePhone } from "../util/phone";

export interface GooglePerson {
  resourceName: string;
  etag?: string;
  metadata?: { deleted?: boolean };
  names?: Array<{ displayName?: string }>;
  phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  birthdays?: Array<{ date?: { year?: number; month?: number; day?: number } }>;
  organizations?: Array<{ name?: string; title?: string }>;
  memberships?: Array<{ contactGroupMembership?: { contactGroupResourceName?: string } }>;
}

// ---------- extração canônica (compartilhada por pull E push) ----------
// Vive aqui (e não em sync.ts) pra push.ts comparar vault×Google com EXATAMENTE a
// mesma regra do pull, sem ciclo de import (sync.ts reexporta pra compatibilidade).

export interface ExtractedPerson {
  name: string | null;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  company: string | null;
  role: string | null;
  groups: string[];
  deleted: boolean;
}

export function extractPerson(p: GooglePerson): ExtractedPerson {
  const name = p.names?.[0]?.displayName?.trim() || null;
  // canonicalForm já vem E.164 do Google; value cru cai no normalizePhone local.
  const rawPhone = p.phoneNumbers?.[0]?.canonicalForm || p.phoneNumbers?.[0]?.value || null;
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  const email = p.emailAddresses?.[0]?.value?.trim().toLowerCase() || null;
  // Aniversário sem ano é comum na agenda — 0000 marca "ano desconhecido" (o campo
  // é TEXT livre; dia/mês é o que importa pro lembrete).
  const bd = p.birthdays?.find((b) => b.date?.month && b.date?.day)?.date;
  const birthday = bd ? `${String(bd.year ?? 0).padStart(4, "0")}-${String(bd.month).padStart(2, "0")}-${String(bd.day).padStart(2, "0")}` : null;
  const company = p.organizations?.[0]?.name?.trim() || null;
  const role = p.organizations?.[0]?.title?.trim() || null;
  const groups = (p.memberships ?? [])
    .map((m) => m.contactGroupMembership?.contactGroupResourceName)
    .filter((g): g is string => !!g);
  return { name, phone, email, birthday, company, role, groups, deleted: !!p.metadata?.deleted };
}

export interface ContactGroup {
  resourceName: string;
  name: string;
  memberCount: number;
  groupType: string;
}

export type GroupsResult =
  | { ok: true; groups: ContactGroup[] }
  | { ok: false; status: number; error: string };

// Etiquetas do dono (grupos de contato). Inclui os grupos de sistema úteis
// (myContacts/starred) e todos os USER_CONTACT_GROUP — a UI decide o que exibir.
export async function listContactGroups(accessToken: string): Promise<GroupsResult> {
  const res = await fetch(`${API}/contactGroups?pageSize=200&groupFields=name,memberCount,groupType`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ok: false, status: res.status, error: `contact_groups_${res.status}` };
  const data = (await res.json()) as {
    contactGroups?: Array<{ resourceName?: string; formattedName?: string; name?: string; memberCount?: number; groupType?: string }>;
  };
  const groups = (data.contactGroups ?? [])
    .filter((g) => g.resourceName)
    .map((g) => ({
      resourceName: g.resourceName!,
      name: g.formattedName || g.name || g.resourceName!,
      memberCount: g.memberCount ?? 0,
      groupType: g.groupType ?? "",
    }));
  return { ok: true, groups };
}

// ---------- contato individual (write-back, specs/google-contacts-sync.md) ----------
// O JSON volta CRU (Record) de propósito: o push precisa das LISTAS COMPLETAS
// (todos os telefones/e-mails, com type/metadata) pra mutar só o item primário e
// devolver o resto intacto — o updatePersonFields do PATCH substitui a lista inteira.

export type RawPerson = Record<string, any> & { resourceName: string; etag?: string };

export type ContactResult =
  | { ok: true; person: RawPerson }
  | { ok: false; status: number; error: string };

export async function getContact(accessToken: string, resourceName: string): Promise<ContactResult> {
  const res = await fetch(`${API}/${resourceName}?personFields=${PERSON_FIELDS}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ok: false, status: res.status, error: `get_contact_${res.status}` };
  const person = (await res.json()) as RawPerson;
  return { ok: true, person };
}

// PATCH :updateContact — `person` deve carregar etag + resourceName + SÓ as listas
// alteradas; `updatePersonFields` lista os campos que o Google vai SUBSTITUIR por
// inteiro. Etag stale volta como update_contact_400:FAILED_PRECONDITION — o caller
// decide o refetch+retry. Nunca lança.
export async function updateContact(
  accessToken: string,
  resourceName: string,
  person: Record<string, any>,
  updatePersonFields: string[],
): Promise<ContactResult> {
  const q = new URLSearchParams({ updatePersonFields: updatePersonFields.join(","), personFields: PERSON_FIELDS });
  const res = await fetch(`${API}/${resourceName}:updateContact?${q}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(person),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { status?: string } };
      detail = body.error?.status ? `:${body.error.status}` : "";
    } catch { /* corpo não-JSON: segue só com o status HTTP */ }
    return { ok: false, status: res.status, error: `update_contact_${res.status}${detail}` };
  }
  const personOut = (await res.json()) as RawPerson;
  return { ok: true, person: personOut };
}

export type ConnectionsPage =
  | { ok: true; connections: GooglePerson[]; nextPageToken: string | null; nextSyncToken: string | null }
  | { ok: false; status: number; error: string };

// Uma página de connections. Com `syncToken` o Google devolve SÓ o delta (incluindo
// deletados, com metadata.deleted=true); `requestSync=true` pede um nextSyncToken
// novo na última página. 410 = syncToken expirou → a engine recomeça do zero.
export async function listConnectionsPage(
  accessToken: string,
  opts: { pageToken?: string | null; syncToken?: string | null; requestSync?: boolean; pageSize?: number } = {},
): Promise<ConnectionsPage> {
  // pageSize configurável: o teto por invocação do sync (GSYNC_MAX_PERSONS) só
  // funciona se a página do Google não for maior que ele — a engine processa a
  // página INTEIRA antes de checar o teto, e o cursor só salva na fronteira de
  // página. Página de 200 com teto 40 = teto inerte e cap de subrequests estourando.
  const size = Math.max(1, Math.min(opts.pageSize ?? PAGE_SIZE, PAGE_SIZE));
  const q = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: String(size) });
  if (opts.pageToken) q.set("pageToken", opts.pageToken);
  if (opts.syncToken) q.set("syncToken", opts.syncToken);
  if (opts.requestSync) q.set("requestSyncToken", "true");
  const res = await fetch(`${API}/people/me/connections?${q}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ok: false, status: res.status, error: `connections_${res.status}` };
  const data = (await res.json()) as {
    connections?: GooglePerson[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };
  return {
    ok: true,
    connections: data.connections ?? [],
    nextPageToken: data.nextPageToken ?? null,
    nextSyncToken: data.nextSyncToken ?? null,
  };
}
