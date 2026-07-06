// Núcleo PURO do journal (specs/50-console-v2/65-home-hoje-e-journal.md §3): tipos,
// merge de cursores e renderização em HTML. Zero dependência de Env/D1/fetch — é
// importado tanto pelo handler server-side (journal.ts) quanto pelo bundle client
// (client/journal.ts, "Carregar mais" via append), então NUNCA pode puxar `../env.js`
// nem nada que só exista no Worker.
import { esc } from '../util/html.js';

export const SOURCE_KEYS = ['note_created', 'note_updated', 'task_created', 'task_completed', 'contact_event'] as const;
export type SourceKey = typeof SOURCE_KEYS[number];

// Item já pronto pra render — chipLabel/dataKind resolvidos na origem (journal.ts)
// pra esta camada não precisar saber nada sobre notas/tasks/contatos além do shape.
export interface JournalItemView {
  type: SourceKey;
  ts: number;
  id: string;
  title: string;
  url: string;
  private: boolean;
  chipLabel: string;
  dataKind: 'note' | 'task' | 'contact';
}

export interface JournalCursors {
  note_created: { ts: number; id: string } | null;
  note_updated: { ts: number; id: string } | null;
  task_created: { ts: number; id: string } | null;
  task_completed: { ts: number; id: string } | null;
  contact_event: { offset: number } | null;
}

export const EMPTY_CURSORS: JournalCursors = {
  note_created: null,
  note_updated: null,
  task_created: null,
  task_completed: null,
  contact_event: null,
};

const SOURCE_RANK: Record<SourceKey, number> = {
  note_created: 0, note_updated: 1, task_created: 2, task_completed: 3, contact_event: 4,
};

// Ordem total determinística: ts DESC, empate por fonte (ordem fixa acima), empate
// final por id DESC — MESMO desempate usado nas queries SQL de cada fonte, então a
// posição relativa de itens da MESMA fonte no pool combinado é idêntica à do lote
// original (propriedade exigida pelo merge k-way abaixo).
function compareItems(a: JournalItemView, b: JournalItemView): number {
  if (a.ts !== b.ts) return b.ts - a.ts;
  if (a.type !== b.type) return SOURCE_RANK[a.type] - SOURCE_RANK[b.type];
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function cursorForTsId(
  items: JournalItemView[], type: SourceKey, prev: { ts: number; id: string } | null
): { ts: number; id: string } | null {
  const consumed = items.filter((it) => it.type === type);
  if (consumed.length === 0) return prev;
  const last = consumed[consumed.length - 1];
  return { ts: last.ts, id: last.id };
}

function cursorForContactEvent(items: JournalItemView[], prevOffset: number | null): { offset: number } | null {
  const consumed = items.filter((it) => it.type === 'contact_event');
  if (consumed.length === 0) return prevOffset === null ? null : { offset: prevOffset };
  return { offset: (prevOffset ?? 0) + consumed.length };
}

// Funde N streams JÁ ordenados desc (cada um capado em `limit`) num pool único e
// devolve os `limit` mais recentes + o cursor de continuação POR FONTE. Invariante
// do merge k-way: com cada fonte contribuindo até `limit` itens (já orfenados desc),
// os `limit` itens mais recentes GLOBAIS estão sempre contidos na união — nunca falta
// um item mais novo "escondido" atrás do corte de uma fonte. Fonte que não contribuiu
// nenhum item pro resultado desta página mantém o cursor ANTERIOR (nada foi consumido
// dela, então a próxima busca deve repetir a mesma janela) — isso é o que garante
// "sem duplicar nem pular item" entre páginas mesmo com timestamps empatados.
export function mergeJournalPage(
  batches: Record<SourceKey, JournalItemView[]>,
  prevCursors: JournalCursors,
  limit: number,
): { items: JournalItemView[]; cursors: JournalCursors; leftover: boolean } {
  const pool: JournalItemView[] = [];
  for (const key of SOURCE_KEYS) pool.push(...batches[key]);
  pool.sort(compareItems);
  const items = pool.slice(0, limit);

  const cursors: JournalCursors = {
    note_created: cursorForTsId(items, 'note_created', prevCursors.note_created),
    note_updated: cursorForTsId(items, 'note_updated', prevCursors.note_updated),
    task_created: cursorForTsId(items, 'task_created', prevCursors.task_created),
    task_completed: cursorForTsId(items, 'task_completed', prevCursors.task_completed),
    contact_event: cursorForContactEvent(items, prevCursors.contact_event?.offset ?? null),
  };
  return { items, cursors, leftover: pool.length > items.length };
}

// ─────────────────────────── cursor ↔ query string ───────────────────────────
// Sem base64/JSON opaco de propósito: 5 params legíveis, cada um "ts:id" (ts/id
// nunca contêm ':') ou um inteiro puro (contact_event). Mais fácil de debugar e
// nenhuma lógica de encode/decode pra errar.

function encodeTsId(c: { ts: number; id: string } | null): string | null {
  return c ? `${c.ts}:${c.id}` : null;
}

function decodeTsId(raw: string | null): { ts: number; id: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const ts = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (!Number.isFinite(ts) || !id) return null;
  return { ts, id };
}

export function cursorsFromParams(params: URLSearchParams): JournalCursors {
  const ceRaw = params.get('ce');
  const ceOffset = ceRaw !== null ? Number(ceRaw) : NaN;
  return {
    note_created: decodeTsId(params.get('nc')),
    note_updated: decodeTsId(params.get('nu')),
    task_created: decodeTsId(params.get('tc')),
    task_completed: decodeTsId(params.get('td')),
    contact_event: Number.isFinite(ceOffset) && ceOffset > 0 ? { offset: ceOffset } : null,
  };
}

// URL relativa de "carregar mais" pros cursores dados. `null` quando os 5 cursores
// estão vazios (nada a continuar) — o caller decide omitir o link nesse caso.
export function journalUrl(cursors: JournalCursors): string {
  const params = new URLSearchParams();
  const nc = encodeTsId(cursors.note_created); if (nc) params.set('nc', nc);
  const nu = encodeTsId(cursors.note_updated); if (nu) params.set('nu', nu);
  const tc = encodeTsId(cursors.task_created); if (tc) params.set('tc', tc);
  const td = encodeTsId(cursors.task_completed); if (td) params.set('td', td);
  if (cursors.contact_event) params.set('ce', String(cursors.contact_event.offset));
  const qs = params.toString();
  return qs ? `/app/journal?${qs}` : '/app/journal';
}

// ─────────────────────────── render (SSR + append client) ───────────────────────────

function brtDay(ts: number): string {
  const d = new Date(ts - 3 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function brtTime(ts: number): string {
  const d = new Date(ts - 3 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function dayLabel(ts: number, now: number): string {
  const day = brtDay(ts);
  if (day === brtDay(now)) return 'Hoje';
  if (day === brtDay(now - 24 * 60 * 60 * 1000)) return 'Ontem';
  const [y, mo, da] = day.split('-');
  return `${da}/${mo}/${y}`;
}

function renderRow(it: JournalItemView): string {
  const priv = it.private ? '<span class="journal-priv" title="Privado">🔒</span>' : '';
  return `<li class="journal-item" data-kind="${it.dataKind}">
    <span class="journal-time">${esc(brtTime(it.ts))}</span>
    <a class="journal-title" href="${esc(it.url)}">${esc(it.title)}</a>${priv}
    <span class="journal-chip journal-chip-${it.dataKind}">${esc(it.chipLabel)}</span>
  </li>`;
}

// Renderiza um lote (já em ordem cronológica desc) agrupado por dia. `carryLabel` é
// o label do ÚLTIMO grupo já na tela (null na 1ª página) — se o primeiro item cair
// no MESMO dia, o cabeçalho NÃO se repete (mas um novo <ul> ainda abre; visualmente
// contíguo, sem gap perceptível). Devolve `lastLabel` pro PRÓXIMO append decidir o
// mesmo. Critério de aceite: fixture com notas+tasks+eventos intercalados renderiza
// em ordem cronológica com agrupamento por dia.
export function renderJournalItems(
  items: JournalItemView[], now: number, carryLabel: string | null
): { html: string; lastLabel: string | null } {
  if (items.length === 0) return { html: '', lastLabel: carryLabel };
  let openLabel: string | null = null;
  let lastLabel = carryLabel;
  let ulOpen = false;
  const parts: string[] = [];
  for (const it of items) {
    const label = dayLabel(it.ts, now);
    if (label !== openLabel) {
      if (ulOpen) parts.push('</ul>');
      if (label !== lastLabel) parts.push(`<h2 class="journal-day">${esc(label)}</h2>`);
      parts.push('<ul class="journal-list">');
      openLabel = label;
      ulOpen = true;
      lastLabel = label;
    }
    parts.push(renderRow(it));
  }
  if (ulOpen) parts.push('</ul>');
  return { html: parts.join(''), lastLabel };
}
