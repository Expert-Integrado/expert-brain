import type { Env } from '../env.js';
import {
  getStaleOpenQuestions,
  getStaleCentralNoteCandidates,
  countPendingInboxOlderThan,
  type OpenQuestionRow,
  type CentralNoteCandidateRow,
} from '../db/queries.js';

// Resurfacing: o digest diário que devolve conhecimento parado sem o dono precisar
// saber O QUE perguntar (specs/50-console-v2/64-resurfacing-digest.md). Tese
// registrada no próprio vault (nota `37jurd2b810v`): o valor do second brain vem
// do HÁBITO DE CONSULTA, não do armazenamento. Este módulo é SQL puro (zero
// Vectorize/AI) + 1 leitura via o proxy CONTACTS já existente — pensado pra rodar
// 1x/dia no cron (src/scheduled.ts → src/notify.ts), nunca no request path.

export const DAY_MS = 24 * 60 * 60 * 1000;

const QUESTION_AGE_DAYS = 30;
const CENTRAL_NOTE_AGE_DAYS = 90;
const CONTACT_COOLING_DAYS = 60;
const INBOX_STALE_DAYS = 7;

const CAP_QUESTIONS = 3;
const CAP_CENTRAL = 2;
const CENTRAL_POOL_SIZE = 10;
const CAP_CONTACTS = 3;
// /list_entities (contacts) não filtra/ordena por last_contacted — over-fetchamos
// o teto do endpoint (1000) numa ÚNICA chamada e filtramos/ordenamos aqui. Ver
// nota de limitação em fetchCoolingContacts.
const CONTACTS_SCAN_LIMIT = 1000;

export const RESURFACE_DIGEST_META_KEY = 'resurface_digest';
export const RESURFACE_TTL_MS = 20 * 60 * 60 * 1000; // 20h

export interface DigestNoteItem {
  id: string;
  title: string;
  tldr: string;
  age_days: number;
  url: string;
}

export interface DigestCentralNoteItem extends DigestNoteItem {
  degree: number;
}

export interface DigestContactItem {
  id: string;
  name: string;
  category: string | null;
  days_since: number;
  url: string;
}

export interface ResurfaceDigest {
  version: 1;
  generated_at: number;
  open_questions: DigestNoteItem[];
  stale_central_notes: DigestCentralNoteItem[];
  cooling_contacts: DigestContactItem[];
  // true quando a leitura via CONTACTS falhou/não está configurada — a seção acima
  // vem vazia por DEGRADAÇÃO, não porque não há contato esfriando (critério 6).
  contacts_degraded: boolean;
  // null = feature indisponível (ex.: query falhou); número = contagem real (pode ser 0).
  inbox_pending_over_7d: number | null;
  inbox_url: string;
}

function baseUrl(env: Env): string {
  return (env.WORKER_URL ?? '').replace(/\/$/, '');
}

function daysAgo(nowMs: number, thenMs: number): number {
  return Math.max(0, Math.floor((nowMs - thenMs) / DAY_MS));
}

function toQuestionItem(env: Env, row: OpenQuestionRow, nowMs: number): DigestNoteItem {
  return {
    id: row.id,
    title: row.title,
    tldr: row.tldr,
    age_days: daysAgo(nowMs, row.updated_at),
    url: `${baseUrl(env)}/app/notes/${row.id}`,
  };
}

function toCentralItem(env: Env, row: CentralNoteCandidateRow, nowMs: number): DigestCentralNoteItem {
  return {
    id: row.id,
    title: row.title,
    tldr: row.tldr,
    age_days: daysAgo(nowMs, row.updated_at),
    degree: row.degree,
    url: `${baseUrl(env)}/app/notes/${row.id}`,
  };
}

// ─────────────────── sorteio semanal determinístico ───────────────────
// "Variedade sem aleatoriedade real": dado o MESMO pool e a MESMA semana ISO, a
// seleção é sempre idêntica (o cache de 20h e re-runs do cron não mudam o que já
// foi mostrado hoje); na semana seguinte o hash muda e a seleção PODE variar.

function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // segunda=0 .. domingo=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // quinta-feira da semana ISO
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// FNV-1a (não um hash polinomial simples de propósito): `note_id + isoWeek`
// concatena um id ESTÁVEL com uma semana que muda 1 caractere por vez
// ("2025-W41" → "2025-W42") — um hash polinomial ingênuo (h = h*31+c) é uma
// função AFIM do estado acumulado, então trocar só o sufixo desloca todo mundo
// pela MESMA constante e a ORDEM RELATIVA entre notas nunca muda de semana pra
// semana (bug pego pelo teste "semana seguinte pode variar"). O XOR-então-
// multiplica do FNV-1a quebra essa linearidade e dá avalanche de verdade.
function hashStr(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime (32-bit)
  }
  return h >>> 0;
}

// Exportado pra teste direto (determinismo semanal sem precisar montar fixtures
// de nota/edge). `pool` já vem ordenado por grau desc (ver getStaleCentralNoteCandidates).
export function pickWeeklyCentralNotes<T extends { id: string; degree: number }>(
  pool: T[], nowMs: number, cap: number
): T[] {
  if (pool.length <= cap) return pool;
  const week = isoWeekKey(nowMs);
  return [...pool]
    .map((n) => ({ n, score: hashStr(`${n.id}:${week}`) }))
    .sort((a, b) => b.score - a.score || b.n.degree - a.n.degree)
    .slice(0, cap)
    .map((x) => x.n);
}

// ─────────────────── contatos esfriando (proxy CONTACTS) ───────────────────
// LIMITAÇÃO CONHECIDA: /list_entities (expert-contacts) não devolve last_contacted
// nem permite ordenar/filtrar por ele (só id/kind/name/phone/email/role/company/
// website/sector/source/category/avatar_r2_key hoje) — só existe uma leitura por
// entidade (`GET /app/entity?id=`) que traz o detalhe completo. Sem tocar o repo
// expert-contacts nesta spec (fora do repo de trabalho designado), o código abaixo
// já lê `last_contacted`/`category` de forma defensiva (opcional) do payload de
// list_entities: funciona assim que uma extensão aditiva do lado de lá incluir
// esses campos na listagem; até lá, a seção fica vazia em produção (nunca quebra —
// ver `contacts_degraded`). Testado aqui com fixtures que já incluem os campos,
// validando o CONTRATO do lado do Brain.
function parseContactTimestamp(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let s = v.trim().replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

async function fetchCoolingContacts(
  env: Env, nowMs: number, cap: number, includePrivate: boolean
): Promise<{ items: DigestContactItem[]; degraded: boolean }> {
  if (!env.CONTACTS || !env.CONTACTS_PROXY_TOKEN) return { items: [], degraded: true };
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${env.CONTACTS_PROXY_TOKEN}` };
    if (includePrivate) headers['x-include-private'] = '1';
    const res = await env.CONTACTS.fetch(
      new Request(`https://contacts/list_entities?limit=${CONTACTS_SCAN_LIMIT}`, { method: 'GET', headers })
    );
    if (!res.ok) return { items: [], degraded: true };
    const data: any = await res.json().catch(() => null);
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    const cutoff = nowMs - CONTACT_COOLING_DAYS * DAY_MS;
    const candidates = results
      .map((r) => {
        if (!r || typeof r.category !== 'string' || !r.category) return null;
        const ms = parseContactTimestamp(r.last_contacted);
        if (ms === null || ms >= cutoff) return null;
        return { id: String(r.id), name: String(r.name ?? r.id), category: r.category as string, last_contacted_ms: ms };
      })
      .filter((x): x is { id: string; name: string; category: string; last_contacted_ms: number } => x !== null)
      .sort((a, b) => a.last_contacted_ms - b.last_contacted_ms) // mais antigos primeiro
      .slice(0, cap)
      .map((x) => ({
        id: x.id,
        name: x.name,
        category: x.category,
        days_since: daysAgo(nowMs, x.last_contacted_ms),
        url: `${baseUrl(env)}/app/contacts/${x.id}`,
      }));
    return { items: candidates, degraded: false };
  } catch {
    return { items: [], degraded: true };
  }
}

// ─────────────────── payload completo ───────────────────

export function isDigestEmpty(d: ResurfaceDigest): boolean {
  return (
    d.open_questions.length === 0 &&
    d.stale_central_notes.length === 0 &&
    d.cooling_contacts.length === 0 &&
    !d.inbox_pending_over_7d
  );
}

export async function buildResurfaceDigest(
  env: Env, opts: { now: number; includePrivate?: boolean }
): Promise<ResurfaceDigest> {
  const now = opts.now;
  const includePrivate = opts.includePrivate ?? false;

  const [openQRows, centralPool, contacts, inboxCount] = await Promise.all([
    getStaleOpenQuestions(env, now - QUESTION_AGE_DAYS * DAY_MS, CAP_QUESTIONS, includePrivate),
    getStaleCentralNoteCandidates(env, now - CENTRAL_NOTE_AGE_DAYS * DAY_MS, CENTRAL_POOL_SIZE, includePrivate),
    fetchCoolingContacts(env, now, CAP_CONTACTS, includePrivate),
    countPendingInboxOlderThan(env, now - INBOX_STALE_DAYS * DAY_MS).catch(() => null),
  ]);

  const central = pickWeeklyCentralNotes(centralPool, now, CAP_CENTRAL);

  return {
    version: 1,
    generated_at: now,
    open_questions: openQRows.map((r) => toQuestionItem(env, r, now)),
    stale_central_notes: central.map((r) => toCentralItem(env, r, now)),
    cooling_contacts: contacts.items,
    contacts_degraded: contacts.degraded,
    inbox_pending_over_7d: inboxCount,
    inbox_url: `${baseUrl(env)}/app/inbox`,
  };
}

// ─────────────────── cache (tabela meta, TTL 20h) ───────────────────
// Fonte ÚNICA pro cron/home (superfícies do PRÓPRIO dono — mesma justificativa de
// includePrivate=true em runDueReminder/notify.ts: "é superfície do dono, não
// credencial de terceiro"). Computa a query de grau (COUNT em edges) no MÁXIMO
// 1x a cada 20h, nunca no request path.

interface CachedRow { value: string }

export async function readCachedResurfaceDigest(env: Env): Promise<ResurfaceDigest | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(RESURFACE_DIGEST_META_KEY)
    .first<CachedRow>();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as ResurfaceDigest;
  } catch {
    return null;
  }
}

async function writeCachedResurfaceDigest(env: Env, digest: ResurfaceDigest): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(RESURFACE_DIGEST_META_KEY, JSON.stringify(digest)).run();
  } catch (e) {
    console.error('resurface: falha ao gravar cache na meta (digest computado mas não persistido)', e);
  }
}

// Lê o cache; se ausente/vencido (>20h), recomputa com includePrivate=true (dono) e
// grava. Usado pelo cron (notify.ts) e pela home/console (superfícies do dono).
export async function getResurfaceDigest(env: Env, now: number): Promise<ResurfaceDigest> {
  const cached = await readCachedResurfaceDigest(env);
  if (cached && now - cached.generated_at < RESURFACE_TTL_MS) return cached;
  const fresh = await buildResurfaceDigest(env, { now, includePrivate: true });
  await writeCachedResurfaceDigest(env, fresh);
  return fresh;
}

// Caller com escopo restrito (tool MCP `digest` chamada por um PAT `full` SEM o
// escopo `private`, spec 31): NUNCA lê/grava o cache do dono (que pode conter
// notas/contatos privados) — computa direto, respeitando o próprio escopo. É uma
// chamada rara (não é o request path de alta frequência que o cache protege).
export async function getResurfaceDigestScoped(
  env: Env, now: number, includePrivate: boolean
): Promise<ResurfaceDigest> {
  if (includePrivate) return getResurfaceDigest(env, now);
  return buildResurfaceDigest(env, { now, includePrivate: false });
}
