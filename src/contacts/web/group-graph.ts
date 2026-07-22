// Grafo de um GRUPO (kind='group'): membros + arestas internas entre eles.
//   GET /app/entity/group-graph?id=<groupId> — sessão OU Bearer CONTACTS_PROXY_TOKEN
//   read-only (allowlist em handler.ts).
//
// Diferente de neighbors (vizinhança egocêntrica de qualquer entidade), aqui o
// foco é a REDE INTERNA do grupo: quem são os membros (edge member_of com o
// grupo) e como eles se relacionam ENTRE SI. As arestas retornadas são só as
// connections cujas DUAS pontas são membros deste grupo — tipicamente
// interacts_with (conversam entre si no WhatsApp), mas qualquer vínculo
// explícito entre dois membros entra (friend, works_at ⇒ só se ambos membros).
//
// SQL puro, sem Vectorize. Privacidade (spec 61): membro privado some pra quem
// não vê privados (resolveMembers filtra), e some junto qualquer aresta que o
// toque — o grafo nunca vaza a existência de um nó privado.

import type { Env } from '../env.js';
import { callerSeesPrivate } from './privacy.js';

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...init?.headers,
    },
  });

// Grupo grande viraria hairball ilegível e payload pesado — teto generoso pro
// caso comum (grupos de WhatsApp raramente passam disso na base do dono) e o
// client avisa quando trunca.
const MEMBER_CAP = 200;

interface MemberRow { id: string; name: string; kind: string; }
interface EdgeRow { a_id: string; b_id: string; type: string; strength: number; }

export interface GroupMember { id: string; label: string; kind: string; degree: number; }
export interface GroupEdge { source: string; target: string; type: string; strength: number; }

async function resolveMembers(env: Env, ids: string[], includePrivate: boolean): Promise<Map<string, MemberRow>> {
  const map = new Map<string, MemberRow>();
  if (ids.length === 0) return map;
  const priv = includePrivate ? '' : ' AND private = 0';
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT id, name, kind FROM entities WHERE id IN (${ph})${priv}`,
    ).bind(...chunk).all<MemberRow>();
    for (const row of r.results ?? []) map.set(row.id, row);
  }
  return map;
}

export async function handleGroupGraph(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return json({ ok: false, error: 'id_required' }, { status: 400 });

  const includePrivate = await callerSeesPrivate(req, env);
  const group = await env.DB.prepare('SELECT id, name, kind, private FROM entities WHERE id = ?')
    .bind(id).first<MemberRow & { private: number }>();
  if (!group || (!includePrivate && group.private === 1)) {
    return json({ ok: false, error: 'entity_not_found', id }, { status: 404 });
  }
  // Só faz sentido pra grupo (person não tem "membros"); resposta explícita
  // deixa o client esconder a seção sem adivinhar.
  if (group.kind !== 'group') {
    return json({ ok: true, is_group: false, group: { id: group.id, label: group.name }, members: [], edges: [] });
  }

  // Membros = quem tem member_of com este grupo (edge normalizado pode ter o
  // grupo em a_id ou b_id).
  const memberRows = (
    await env.DB.prepare(
      `SELECT a_id, b_id FROM connections WHERE type = 'member_of' AND (a_id = ? OR b_id = ?)`,
    ).bind(id, id).all<{ a_id: string; b_id: string }>()
  ).results ?? [];
  const memberIds = new Set<string>();
  for (const r of memberRows) memberIds.add(r.a_id === id ? r.b_id : r.a_id);

  const truncated = memberIds.size > MEMBER_CAP;
  const memberIdList = [...memberIds].slice(0, MEMBER_CAP);
  const entities = await resolveMembers(env, memberIdList, includePrivate);
  // Set final de membros VISÍVEIS (privados sumiram no resolve).
  const visible = new Set(memberIdList.filter((m) => entities.has(m)));

  // Arestas internas: connections com AMBAS as pontas em `visible`, exceto o
  // próprio member_of com o grupo (o grupo não é membro de si). interacts_with é
  // o caso comum; qualquer vínculo explícito entre dois membros também entra.
  const degree = new Map<string, number>();
  const edges: GroupEdge[] = [];
  if (visible.size > 0) {
    const ids = [...visible];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const ph = chunk.map(() => '?').join(',');
      const rows = (
        await env.DB.prepare(
          `SELECT a_id, b_id, type, strength FROM connections
           WHERE type != 'member_of' AND a_id IN (${ph})`,
        ).bind(...chunk).all<EdgeRow>()
      ).results ?? [];
      for (const e of rows) {
        // dedupe: só conta o par uma vez (a consulta é por a_id ∈ chunk; um par
        // interno aparece uma vez porque o par é normalizado a_id<b_id no insert).
        if (!visible.has(e.b_id)) continue;
        edges.push({ source: e.a_id, target: e.b_id, type: e.type, strength: e.strength });
        degree.set(e.a_id, (degree.get(e.a_id) ?? 0) + 1);
        degree.set(e.b_id, (degree.get(e.b_id) ?? 0) + 1);
      }
    }
  }

  const members: GroupMember[] = [...visible].map((mid) => {
    const ent = entities.get(mid)!;
    return { id: mid, label: ent.name, kind: ent.kind, degree: degree.get(mid) ?? 0 };
  });
  // Mais conectados primeiro — a lista textual acompanha o grafo.
  members.sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

  return json({
    ok: true,
    is_group: true,
    group: { id: group.id, label: group.name },
    members,
    edges,
    total_members: memberIds.size,
    truncated,
  });
}
