// Cartela de canais de contato — normalização/validação por kind + write path.
//
// Spec 50-console-v2/55: uma pessoa/empresa tem N e-mails, redes sociais, link de
// CRM e ID de ManyChat. A tabela `entity_channels` (migration 0006) guarda todos;
// as colunas `entities.email`/`entities.phone` viram ESPELHO do canal primário do
// seu kind (compat total com dedupe por telefone e lookup determinístico).
//
// Fonte ÚNICA de:
//   - validação/normalização por kind (normalizeChannel) — servidor valida, MCP repassa;
//   - geração de href (channelHref) pro read path (fields[] clicáveis);
//   - escrita transacional do canal primário (setPrimaryChannel) e do espelho.
//
// Regra de ouro do espelho: para kind ∈ {email, phone}, a coluna entities.<kind>
// SEMPRE bate com o valor do canal primário daquele kind (ou NULL se não houver).

import type { Env } from "./env";
import { normalizePhone } from "./util/phone";

// kinds válidos de canal (espelha o CHECK da migration 0006).
export const CHANNEL_KINDS = [
  "email", "phone", "instagram", "linkedin", "crm", "manychat", "site", "other",
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_KINDS_SET = new Set<string>(CHANNEL_KINDS);

// kinds cujo canal primário espelha uma COLUNA de entities (dedupe/lookup dependem).
export const MIRROR_COLUMNS: Record<string, "email" | "phone"> = {
  email: "email",
  phone: "phone",
};

export const MAX_CHANNEL_VALUE = 200;
export const MAX_CHANNEL_LABEL = 40;

export interface ChannelInput {
  kind: string;
  value: string;
  label?: string | null;
  primary?: boolean;
}

export interface NormalizedChannel {
  kind: ChannelKind;
  value: string;
  label: string | null;
  primary: boolean;
  href: string | null;
}

export type NormalizeResult =
  | { ok: true; channel: NormalizedChannel }
  | { ok: false; error: string };

// regex leve x@y.z (mesma filosofia do resto do repo — não é RFC completa).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INSTAGRAM_RE = /^[a-z0-9._]{1,30}$/;
const LINKEDIN_HANDLE_RE = /^[\w-]{3,100}$/;

function parseHttpUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// Extrai o handle do instagram de "@x", "x" ou URL "instagram.com/x".
function instagramHandle(raw: string): string {
  const v = raw.trim();
  const m = v.match(/instagram\.com\/([^/?#]+)/i);
  const handle = m ? m[1] : v;
  return handle.replace(/^@/, "").toLowerCase();
}

// Normaliza + valida + gera href de UM canal. NÃO toca no banco. Servidor chama
// isto antes de qualquer escrita (invalido => 400, nada persiste).
export function normalizeChannel(input: ChannelInput): NormalizeResult {
  const kind = String(input.kind ?? "").trim().toLowerCase();
  if (!CHANNEL_KINDS_SET.has(kind)) {
    return { ok: false, error: `invalid channel kind: ${kind || "(empty)"}` };
  }

  const label = input.label == null ? null : (String(input.label).trim() || null);
  if (label && label.length > MAX_CHANNEL_LABEL) {
    return { ok: false, error: `channel label too long (max ${MAX_CHANNEL_LABEL})` };
  }
  const primary = input.primary === true;

  let value = (input.value == null ? "" : String(input.value)).trim();
  if (!value) return { ok: false, error: `channel value required for kind ${kind}` };

  let href: string | null = null;

  switch (kind) {
    case "email": {
      value = value.toLowerCase();
      if (!EMAIL_RE.test(value)) return { ok: false, error: "invalid email (formato x@y.z)" };
      href = `mailto:${value}`;
      break;
    }
    case "phone": {
      const digits = normalizePhone(value);
      if (!digits || digits.length < 8 || digits.length > 15) {
        return { ok: false, error: "invalid phone (8-15 dígitos, E.164 sem +)" };
      }
      value = digits;
      href = `https://wa.me/${value}`;
      break;
    }
    case "instagram": {
      const handle = instagramHandle(value);
      if (!INSTAGRAM_RE.test(handle)) return { ok: false, error: "invalid instagram handle" };
      value = handle;
      href = `https://instagram.com/${handle}`;
      break;
    }
    case "linkedin": {
      let v = value;
      if (!/^https?:\/\//i.test(v) && /linkedin\.com/i.test(v)) v = "https://" + v;
      const u = parseHttpUrl(v);
      if (u) { value = v; href = v; }
      else if (LINKEDIN_HANDLE_RE.test(value)) { href = `https://www.linkedin.com/in/${value}`; }
      else return { ok: false, error: "invalid linkedin (URL https ou handle)" };
      break;
    }
    case "crm": {
      if (!parseHttpUrl(value)) return { ok: false, error: "invalid crm url (http/https obrigatório)" };
      href = value;
      break;
    }
    case "manychat": {
      if (/^https?:\/\//i.test(value)) {
        const u = parseHttpUrl(value);
        if (!u || u.protocol !== "https:") return { ok: false, error: "invalid manychat url (https obrigatório)" };
        href = value;
      } else {
        if (value.length > 100) return { ok: false, error: "manychat id too long (max 100)" };
        href = null;
      }
      break;
    }
    case "site": {
      let candidate = value;
      if (!/^https?:\/\//i.test(candidate)) candidate = "https://" + candidate;
      if (!parseHttpUrl(candidate)) return { ok: false, error: "invalid site url" };
      value = candidate;
      href = candidate;
      break;
    }
    case "other":
    default: {
      href = null;
      break;
    }
  }

  if (value.length > MAX_CHANNEL_VALUE) {
    return { ok: false, error: `channel value too long (max ${MAX_CHANNEL_VALUE})` };
  }
  return { ok: true, channel: { kind: kind as ChannelKind, value, label, primary, href } };
}

// href pro READ path (dado já normalizado no banco / backfill cru). Lenient: nunca
// lança, prefixa https:// pra site sem protocolo (backfill copiou domínio nu).
export function channelHref(kind: string, value: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  switch (kind) {
    case "email": return `mailto:${v}`;
    case "phone": return `https://wa.me/${v.replace(/\D/g, "")}`;
    case "instagram": return `https://instagram.com/${v.replace(/^@/, "")}`;
    case "linkedin": return /^https?:\/\//i.test(v) ? v : `https://www.linkedin.com/in/${v}`;
    case "crm": return /^https?:\/\//i.test(v) ? v : null;
    case "manychat": return /^https?:\/\//i.test(v) ? v : null;
    case "site": return /^https?:\/\//i.test(v) ? v : `https://${v}`;
    default: return null;
  }
}

// ─────────────────────────────── write path ────────────────────────────────

export interface ChannelRow {
  id: string;
  entity_id: string;
  kind: string;
  value: string;
  label: string | null;
  is_primary: number;
  position: number | null;
  created_at: string;
}

// Lista os canais de uma entidade, ordenados por kind → primário → posição.
export async function getChannels(env: Env, entityId: string): Promise<ChannelRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, entity_id, kind, value, label, is_primary, position, created_at
       FROM entity_channels WHERE entity_id = ?
      ORDER BY kind, is_primary DESC, position ASC, created_at ASC`,
  ).bind(entityId).all<ChannelRow>();
  return r.results ?? [];
}

// Upsert por (entity_id, kind, value). Existe => atualiza label (se veio); senão
// INSERT com a próxima position do kind. NÃO mexe em is_primary aqui.
async function upsertChannelRow(
  env: Env,
  entityId: string,
  ch: NormalizedChannel,
): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare(
    `SELECT id FROM entity_channels WHERE entity_id = ? AND kind = ? AND value = ?`,
  ).bind(entityId, ch.kind, ch.value).first<{ id: string }>();
  if (existing) {
    if (ch.label !== null) {
      await env.DB.prepare(`UPDATE entity_channels SET label = ? WHERE id = ?`)
        .bind(ch.label, existing.id).run();
    }
    return { id: existing.id, created: false };
  }
  const posRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM entity_channels WHERE entity_id = ? AND kind = ?`,
  ).bind(entityId, ch.kind).first<{ p: number }>();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entity_channels (id, entity_id, kind, value, label, is_primary, position)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).bind(id, entityId, ch.kind, ch.value, ch.label, posRow?.p ?? 0).run();
  return { id, created: true };
}

export type SetPrimaryResult = { ok: true } | { ok: false; error: string };

// Marca UM canal como primário do seu kind, TRANSACIONALMENTE (batch atômico):
// zera os outros do mesmo kind, seta este, e — se o kind espelha coluna — grava a
// coluna na MESMA transação. Guard: promover telefone de OUTRA entidade quebraria o
// UNIQUE(entities.phone); falha com mensagem (merge é a spec 34).
export async function setPrimaryChannel(
  env: Env,
  entityId: string,
  channelId: string,
): Promise<SetPrimaryResult> {
  const ch = await env.DB.prepare(
    `SELECT id, kind, value FROM entity_channels WHERE id = ? AND entity_id = ?`,
  ).bind(channelId, entityId).first<{ id: string; kind: string; value: string }>();
  if (!ch) return { ok: false, error: "channel not found" };

  const mirrorCol = MIRROR_COLUMNS[ch.kind];
  if (mirrorCol === "phone") {
    const other = await env.DB.prepare(
      `SELECT id FROM entities WHERE phone = ? AND id != ?`,
    ).bind(ch.value, entityId).first<{ id: string }>();
    if (other) return { ok: false, error: "phone já usado por outra entidade (use merge)" };
  }

  const stmts = [
    env.DB.prepare(`UPDATE entity_channels SET is_primary = 0 WHERE entity_id = ? AND kind = ?`).bind(entityId, ch.kind),
    env.DB.prepare(`UPDATE entity_channels SET is_primary = 1 WHERE id = ?`).bind(channelId),
  ];
  if (mirrorCol) {
    stmts.push(env.DB.prepare(`UPDATE entities SET ${mirrorCol} = ? WHERE id = ?`).bind(ch.value, entityId));
  }
  await env.DB.batch(stmts);
  return { ok: true };
}

// Garante o invariante do espelho de um kind: se não há primário mas há canais,
// promove o de menor posição; grava a coluna com o valor do primário (ou NULL).
// Só age em kind que espelha coluna. Phone: se o valor colidir com outra entidade,
// NÃO sobrescreve a coluna (evita 500 no UNIQUE — merge é outra spec).
async function reconcileMirror(env: Env, entityId: string, kind: string): Promise<void> {
  const mirrorCol = MIRROR_COLUMNS[kind];
  if (!mirrorCol) return;

  let primary = await env.DB.prepare(
    `SELECT id, value FROM entity_channels WHERE entity_id = ? AND kind = ? AND is_primary = 1 LIMIT 1`,
  ).bind(entityId, kind).first<{ id: string; value: string }>();

  if (!primary) {
    primary = await env.DB.prepare(
      `SELECT id, value FROM entity_channels WHERE entity_id = ? AND kind = ?
        ORDER BY position ASC, created_at ASC LIMIT 1`,
    ).bind(entityId, kind).first<{ id: string; value: string }>();
    if (primary) {
      await env.DB.prepare(`UPDATE entity_channels SET is_primary = 1 WHERE id = ?`).bind(primary.id).run();
    }
  }

  const colVal = primary ? primary.value : null;
  if (mirrorCol === "phone" && colVal) {
    const other = await env.DB.prepare(`SELECT id FROM entities WHERE phone = ? AND id != ?`)
      .bind(colVal, entityId).first();
    if (other) return; // colisão: não sobrescreve
  }
  await env.DB.prepare(`UPDATE entities SET ${mirrorCol} = ? WHERE id = ?`).bind(colVal, entityId).run();
}

// Remove UM canal e reconcilia o espelho do seu kind (promove o próximo / NULL).
export async function removeChannel(
  env: Env,
  entityId: string,
  channelId: string,
): Promise<{ ok: boolean; error?: string; kind?: string }> {
  const ch = await env.DB.prepare(
    `SELECT id, kind FROM entity_channels WHERE id = ? AND entity_id = ?`,
  ).bind(channelId, entityId).first<{ id: string; kind: string }>();
  if (!ch) return { ok: false, error: "channel not found" };
  await env.DB.prepare(`DELETE FROM entity_channels WHERE id = ?`).bind(channelId).run();
  await reconcileMirror(env, entityId, ch.kind);
  return { ok: true, kind: ch.kind };
}

// ───────────────────────── contrato de escrita (REST/MCP/Console) ───────────

export interface ChannelWriteInput {
  channels?: Array<{ kind?: unknown; value?: unknown; label?: unknown; primary?: unknown }>;
  channels_remove?: unknown;
  emails?: unknown;
  instagram?: unknown;
  linkedin?: unknown;
  crm_url?: unknown;
  manychat_id?: unknown;
}

// Coleta os inputs de canal (atalhos do MCP + array explícito) num ChannelInput[].
export function collectChannelInputs(body: ChannelWriteInput): ChannelInput[] {
  const out: ChannelInput[] = [];
  if (Array.isArray(body.emails)) {
    for (const e of body.emails) if (e != null && String(e).trim()) out.push({ kind: "email", value: String(e) });
  }
  const single = (v: unknown, kind: string) => {
    if (v != null && String(v).trim()) out.push({ kind, value: String(v) });
  };
  single(body.instagram, "instagram");
  single(body.linkedin, "linkedin");
  single(body.crm_url, "crm");
  single(body.manychat_id, "manychat");
  if (Array.isArray(body.channels)) {
    for (const c of body.channels) {
      if (c && typeof c === "object" && c.kind != null && c.value != null) {
        out.push({
          kind: String(c.kind),
          value: String(c.value),
          label: c.label == null ? null : String(c.label),
          primary: c.primary === true,
        });
      }
    }
  }
  return out;
}

// Lê a lista de ids pra remoção do corpo (channels_remove: string[]).
export function collectChannelRemovals(body: ChannelWriteInput): string[] {
  return Array.isArray(body.channels_remove)
    ? body.channels_remove.map((x) => String(x)).filter(Boolean)
    : [];
}

export type ValidateResult =
  | { ok: true; channels: NormalizedChannel[] }
  | { ok: false; error: string };

// Valida TODOS os inputs ANTES de qualquer escrita. 1º inválido aborta (nada persiste).
export function validateChannelInputs(inputs: ChannelInput[]): ValidateResult {
  const norm: NormalizedChannel[] = [];
  for (const inp of inputs) {
    const r = normalizeChannel(inp);
    if (!r.ok) return { ok: false, error: r.error };
    norm.push(r.channel);
  }
  return { ok: true, channels: norm };
}

// Persiste canais (upsert + primário + reconcile do espelho) e remove os pedidos.
// Canais JÁ validados. NÃO remove canais ausentes (save parcial não destrói).
export async function persistChannels(
  env: Env,
  entityId: string,
  channels: NormalizedChannel[],
  removeIds: string[] = [],
): Promise<void> {
  const touchedMirrorKinds = new Set<string>();

  for (const rid of removeIds) {
    const res = await removeChannel(env, entityId, rid);
    if (res.ok && res.kind && MIRROR_COLUMNS[res.kind]) touchedMirrorKinds.add(res.kind);
  }

  const explicitPrimary: string[] = [];
  for (const ch of channels) {
    const { id } = await upsertChannelRow(env, entityId, ch);
    if (MIRROR_COLUMNS[ch.kind]) touchedMirrorKinds.add(ch.kind);
    if (ch.primary) explicitPrimary.push(id);
  }
  for (const id of explicitPrimary) {
    await setPrimaryChannel(env, entityId, id);
  }
  for (const kind of touchedMirrorKinds) {
    await reconcileMirror(env, entityId, kind);
  }
}

// Canais-espelho dos params LEGADOS (email/phone/website). Best-effort e FIEL à
// coluna (não relança casing do e-mail) pra manter o invariante coluna==primário
// sem quebrar chamadas antigas (email malformado só não gera href).
export function legacyMirrorChannels(opts: {
  phone?: string | null;
  email?: unknown;
  kind?: string;
  website?: unknown;
}): NormalizedChannel[] {
  const out: NormalizedChannel[] = [];
  if (opts.phone) {
    out.push({ kind: "phone", value: opts.phone, label: null, primary: true, href: `https://wa.me/${opts.phone}` });
  }
  if (opts.email != null && String(opts.email).trim()) {
    const raw = String(opts.email).trim();
    out.push({
      kind: "email",
      value: raw,
      label: null,
      primary: true,
      href: EMAIL_RE.test(raw.toLowerCase()) ? `mailto:${raw}` : null,
    });
  }
  if (opts.kind === "company" && opts.website != null && String(opts.website).trim()) {
    const r = normalizeChannel({ kind: "site", value: String(opts.website) });
    if (r.ok) out.push(r.channel);
  }
  return out;
}
