// Tecido conectivo — efeitos colaterais da MENÇÃO (spec 50-console-v2/62).
//
// A persistência da menção (tabela `mentions`) vive em src/db/queries.ts; este módulo
// cuida do que a menção DISPARA no vault de contatos (expert-contacts, Worker separado
// via service binding CONTACTS): cache do nome (entity_label), evento `mentioned_in_brain`
// na timeline do contato, e a checagem de visibilidade pra omitir o nome de contato
// privado nos retornos MCP.
//
// PRINCÍPIO DURO (critério de aceite 7): NADA aqui pode derrubar o save da nota/task. A
// timeline do contato é ECO, não fonte — toda chamada ao contacts é best-effort e
// engolida. A menção (D1 local) já está gravada antes de qualquer roundtrip.

import type { Env } from '../env.js';
import { newId } from '../util/id.js';
import { upsertMention, removeMention, listMentionsForNote } from '../db/queries.js';

// Leitura do contacts via service binding + Bearer read-only (CONTACTS_PROXY_TOKEN). O
// header X-Include-Private propaga o escopo do caller do Brain downstream — mesma
// convenção de src/mcp/tools/contacts.ts (auto-restrição por request).
async function contactsGet(
  env: Env, path: string, includePrivate: boolean
): Promise<{ ok: boolean; status: number; data: any }> {
  if (!env.CONTACTS || !env.CONTACTS_PROXY_TOKEN) return { ok: false, status: 503, data: null };
  const headers: Record<string, string> = { authorization: `Bearer ${env.CONTACTS_PROXY_TOKEN}` };
  if (includePrivate) headers['x-include-private'] = '1';
  const res = await env.CONTACTS.fetch(new Request(`https://contacts${path}`, { method: 'GET', headers }));
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Nome canônico do contato pra cachear em mentions.entity_label (best-effort). Usa o
// escopo do caller (header quando seePrivate). Contato ausente/erro → null: menção órfã
// é aceitável (spec 62 riscos) e o render cai no id.
export async function fetchContactLabel(env: Env, entityId: string, seePrivate: boolean): Promise<string | null> {
  try {
    const r = await contactsGet(env, `/app/entity?id=${encodeURIComponent(entityId)}`, seePrivate);
    if (r.ok && r.data && typeof r.data.title === 'string' && r.data.title.trim()) {
      return r.data.title.trim();
    }
  } catch { /* swallow — label é cache best-effort, nunca derruba o save */ }
  return null;
}

// Ids VISÍVEIS a um caller SEM escopo `private` (contato público). Chama o contacts SEM
// o header X-Include-Private: contato privado → 404 → fica FORA do set → o label é omitido
// no retorno MCP (critério 8, não vaza o nome). Erro de rede → id fora do set (fail-closed).
export async function publicVisibleEntityIds(env: Env, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const uniq = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
  await Promise.all(uniq.map(async (id) => {
    try {
      const r = await contactsGet(env, `/app/entity?id=${encodeURIComponent(id)}`, false);
      if (r.ok) out.add(id);
    } catch { /* fail-closed: id não entra no set */ }
  }));
  return out;
}

// Dispara `mentioned_in_brain` na timeline do contato (spec 62 §3.1) via CONTACTS_WRITE_TOKEN
// (allowlist de 1 path do lado do contacts). NON-FATAL: binding ausente, contacts fora do
// ar ou entidade inexistente são engolidos — o save da nota/task não pode falhar (critério 7).
export async function dispatchMentionEvent(env: Env, entityId: string, context: string): Promise<void> {
  try {
    if (!env.CONTACTS || !env.CONTACTS_WRITE_TOKEN) return;
    await env.CONTACTS.fetch(new Request('https://contacts/app/entity/event', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CONTACTS_WRITE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_id: entityId,
        kind: 'mentioned_in_brain',
        context: context.slice(0, 2000),
        source: 'brain_bridge',
      }),
    }));
  } catch (err) {
    console.error('mentions: dispatchMentionEvent failed (save unaffected)', err);
  }
}

export interface ApplyMentionsInput {
  noteId: string;
  title: string;
  url: string;
  add?: string[];      // entity ids a mencionar (upsert por par; dispara evento se novo)
  remove?: string[];   // entity ids a remover
  seePrivate: boolean; // escopo do caller (header do fetch de label)
}

// Aplica add/remove de menções e dispara os efeitos (evento na timeline pra cada menção
// NOVA). TOTALMENTE tolerante a falha — todo o corpo é try/catch: uma falha aqui NUNCA
// derruba o save (critério 7). A menção (D1) já foi gravada; o resto é eco. Retorna a
// contagem pra a tool ecoar. Remoção NÃO apaga o evento já disparado (timeline é histórico).
export async function applyMentions(
  env: Env, input: ApplyMentionsInput
): Promise<{ created: number; removed: number }> {
  let created = 0;
  let removed = 0;
  try {
    const now = Date.now();
    for (const raw of input.remove ?? []) {
      const id = raw.trim();
      if (!id) continue;
      if (await removeMention(env, input.noteId, id)) removed++;
    }
    for (const raw of input.add ?? []) {
      const id = raw.trim();
      if (!id) continue;
      const label = await fetchContactLabel(env, id, input.seePrivate);
      const isNew = await upsertMention(env, {
        id: newId(), noteId: input.noteId, entityId: id, entityLabel: label, now,
      });
      if (isNew) {
        created++;
        await dispatchMentionEvent(env, id, `${input.title} · ${input.url}`);
      }
    }
  } catch (err) {
    console.error('mentions: applyMentions failed (save unaffected)', err);
  }
  return { created, removed };
}

// Array de menções pro retorno MCP de get_note/get_task (spec 62 §4). Caller COM escopo
// private → label sempre; SEM escopo → label omitido pra contato PRIVADO (só entity_id,
// não vaza o nome, critério 8). Contacts indisponível → fail-closed (sem label).
export async function mentionsForOutput(
  env: Env, noteId: string, seePrivate: boolean
): Promise<Array<{ entity_id: string; label?: string }>> {
  const rows = await listMentionsForNote(env, noteId);
  if (rows.length === 0) return [];
  if (seePrivate) {
    return rows.map((r) => (r.entity_label
      ? { entity_id: r.entity_id, label: r.entity_label }
      : { entity_id: r.entity_id }));
  }
  let visible = new Set<string>();
  try {
    visible = await publicVisibleEntityIds(env, rows.map((r) => r.entity_id));
  } catch { visible = new Set<string>(); }
  return rows.map((r) => (visible.has(r.entity_id) && r.entity_label
    ? { entity_id: r.entity_id, label: r.entity_label }
    : { entity_id: r.entity_id }));
}
