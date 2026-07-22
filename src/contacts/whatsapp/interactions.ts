// Grafo social REAL — integração OPCIONAL WhatsApp Agent, interações → conexões
// (specs/whatsapp-interactions.md). Complemento do sync de grupos (sync.ts):
// member_of diz "estão no mesmo grupo"; interacts_with diz "CONVERSAM entre si"
// (replies diretos observados nas mensagens de grupo).
//
// Regras (mesma política conservadora do sync de grupos):
//   - O AGENTE agrega (SQL no banco do WhatsApp Agent) e empurra pares prontos —
//     o Worker nunca consulta nada fora (push, nunca pull).
//   - Só cria conexão entre pessoas que JÁ existem no vault (match por variantes
//     de telefone). Par com ponta desconhecida é contado e descartado.
//   - Upsert idempotente: a conexão criada por ESTE sync (marcador no why) é
//     atualizada (contagem/strength crescem); conexão manual de outro tipo nunca
//     é tocada. interacts_with é SIMÉTRICO (canon.ts) — o par é normalizado.
//   - strength derivada da frequência, com teto: 0.3 base + 0.02/reply, cap 0.8
//     (nunca compete com vínculo declarado tipo friend/family setado pelo dono).

import type { Env } from "../env";
import { phoneVariants } from "../util/phone";
import { normalizeConnPair } from "../canon";

export const WAINTERACTIONS_KV = {
  lastRun: "wainteractions:last_run", // resumo da última importação (status do painel)
} as const;

// Marcador do why: identifica conexão criada por ESTE sync (update em vez de
// duplicar; nunca toca edge manual).
export const WAINTERACTIONS_WHY_PREFIX = "Conversam entre si em grupos do WhatsApp";

const PAIRS_MAX = 300;      // cap por push (payload e subrequests D1 sob controle)
const GROUPS_IN_WHY_MAX = 3; // nomes de grupo citados no why

export interface WaInteractionPair {
  a_phone: string;
  b_phone: string;
  replies: number;        // respostas diretas observadas entre os dois (ambas direções)
  groups: string[];       // nomes dos grupos onde interagiram
}

export interface WaInteractionsResult {
  ok: boolean;
  pairs_received: number;
  connections_created: number;
  connections_updated: number;
  skipped_unknown: number;   // par com pelo menos uma ponta fora do vault
  skipped_self: number;      // mesmas variantes dos dois lados (auto-par)
}

export function sanitizePairs(body: unknown): WaInteractionPair[] | null {
  const pairs = (body as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs)) return null;
  const out: WaInteractionPair[] = [];
  for (const p of pairs.slice(0, PAIRS_MAX)) {
    const a = typeof (p as any)?.a_phone === "string" ? (p as any).a_phone.trim() : "";
    const b = typeof (p as any)?.b_phone === "string" ? (p as any).b_phone.trim() : "";
    const replies = Number((p as any)?.replies);
    if (!a || !b || !Number.isFinite(replies) || replies < 1) continue;
    const groups = Array.isArray((p as any)?.groups)
      ? (p as any).groups.filter((g: unknown): g is string => typeof g === "string" && g.trim().length > 0).slice(0, 10)
      : [];
    out.push({ a_phone: a, b_phone: b, replies: Math.floor(replies), groups });
  }
  return out;
}

export function interactionStrength(replies: number): number {
  return Math.min(0.8, 0.3 + replies * 0.02);
}

function buildWhy(replies: number, groups: string[], windowDays: number | null): string {
  const gs = groups.slice(0, GROUPS_IN_WHY_MAX).map((g) => `"${g}"`).join(", ");
  const janela = windowDays ? ` nos últimos ${windowDays} dias` : "";
  const onde = gs ? ` (${gs})` : "";
  return `${WAINTERACTIONS_WHY_PREFIX}: ${replies} resposta(s) direta(s)${janela}${onde} — sync WhatsApp Agent`;
}

// Resolve todos os telefones do payload num lote só (mesma técnica do
// matchParticipants do sync de grupos: variantes agregadas, SELECT IN chunked).
async function resolvePhones(env: Env, phones: Set<string>): Promise<Map<string, string>> {
  const variantsOf = new Map<string, string[]>();
  const allVariants = new Set<string>();
  for (const p of phones) {
    const v = phoneVariants(p);
    if (v.length === 0) continue;
    variantsOf.set(p, v);
    for (const x of v) allVariants.add(x);
  }
  const byVariant = new Map<string, string>();
  const list = [...allVariants];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const ph = chunk.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id, phone FROM entities WHERE kind = 'person' AND phone IN (${ph})`
    ).bind(...chunk).all<{ id: string; phone: string }>();
    for (const row of r.results ?? []) byVariant.set(row.phone, row.id);
  }
  const resolved = new Map<string, string>(); // phone cru → entity_id
  for (const [p, vs] of variantsOf) {
    const hit = vs.map((x) => byVariant.get(x)).find((id): id is string => !!id);
    if (hit) resolved.set(p, hit);
  }
  return resolved;
}

export async function importWaInteractions(
  env: Env,
  pairs: WaInteractionPair[],
  windowDays: number | null,
): Promise<WaInteractionsResult> {
  const r: WaInteractionsResult = {
    ok: true, pairs_received: pairs.length,
    connections_created: 0, connections_updated: 0,
    skipped_unknown: 0, skipped_self: 0,
  };

  const phones = new Set<string>();
  for (const p of pairs) { phones.add(p.a_phone); phones.add(p.b_phone); }
  const resolved = await resolvePhones(env, phones);

  for (const p of pairs) {
    const aId = resolved.get(p.a_phone);
    const bId = resolved.get(p.b_phone);
    if (!aId || !bId) { r.skipped_unknown++; continue; }
    if (aId === bId) { r.skipped_self++; continue; }

    const [x, y] = normalizeConnPair(aId, bId, "interacts_with");
    const why = buildWhy(p.replies, p.groups, windowDays);
    const strength = interactionStrength(p.replies);

    const existing = await env.DB.prepare(
      `SELECT id, why FROM connections WHERE a_id = ? AND b_id = ? AND type = 'interacts_with'`
    ).bind(x, y).first<{ id: string; why: string }>();

    if (existing) {
      // Edge manual do dono (why sem o marcador): intocado — o dono sabe mais.
      if (!existing.why?.startsWith(WAINTERACTIONS_WHY_PREFIX)) continue;
      await env.DB.prepare(
        `UPDATE connections SET strength = ?, why = ? WHERE id = ?`
      ).bind(strength, why, existing.id).run();
      r.connections_updated++;
    } else {
      await env.DB.prepare(
        `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, 'interacts_with', ?, ?)`
      ).bind(crypto.randomUUID(), x, y, strength, why).run();
      r.connections_created++;
    }
  }

  await env.CACHE.put(WAINTERACTIONS_KV.lastRun, JSON.stringify({ ...r, at: new Date().toISOString() }));
  return r;
}
