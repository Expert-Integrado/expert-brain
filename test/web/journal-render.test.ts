import { describe, it, expect } from 'vitest';
import {
  mergeJournalPage,
  renderJournalItems,
  cursorsFromParams,
  journalUrl,
  EMPTY_CURSORS,
  type JournalItemView,
  type SourceKey,
} from '../../src/web/journal-render.js';

// Núcleo puro do journal (specs/50-console-v2/65-home-hoje-e-journal.md §3, critério
// "'Carregar mais' pagina sem duplicar nem pular item"). Zero D1/fetch — testa só o
// merge k-way e a renderização em memória.

function item(type: SourceKey, ts: number, id: string, title = id): JournalItemView {
  return { type, ts, id, title, url: `/x/${id}`, private: false, chipLabel: type, dataKind: type.startsWith('note') ? 'note' : type.startsWith('task') ? 'task' : 'contact' };
}

function emptyBatches(): Record<SourceKey, JournalItemView[]> {
  return { note_created: [], note_updated: [], task_created: [], task_completed: [], contact_event: [] };
}

describe('mergeJournalPage', () => {
  it('funde 2 fontes por ts desc, mantendo ordem cronológica global', () => {
    const batches = emptyBatches();
    batches.note_created = [item('note_created', 300, 'n3'), item('note_created', 100, 'n1')];
    batches.task_created = [item('task_created', 200, 't2')];
    const { items } = mergeJournalPage(batches, EMPTY_CURSORS, 10);
    expect(items.map((i) => i.id)).toEqual(['n3', 't2', 'n1']);
  });

  it('empate de ts entre fontes é desempatado de forma determinística (mesma ordem sempre)', () => {
    const batches = emptyBatches();
    batches.note_created = [item('note_created', 100, 'n1')];
    batches.task_created = [item('task_created', 100, 't1')];
    const r1 = mergeJournalPage(batches, EMPTY_CURSORS, 10);
    const r2 = mergeJournalPage(batches, EMPTY_CURSORS, 10);
    expect(r1.items.map((i) => i.id)).toEqual(r2.items.map((i) => i.id));
  });

  it('cursor avança SÓ pra fontes que contribuíram itens nesta página', () => {
    const batches = emptyBatches();
    batches.note_created = [item('note_created', 300, 'n3'), item('note_created', 200, 'n2')];
    batches.task_created = [item('task_created', 100, 't1')]; // mais velho, fica fora do limit=2
    const { items, cursors } = mergeJournalPage(batches, EMPTY_CURSORS, 2);
    expect(items.map((i) => i.id)).toEqual(['n3', 'n2']);
    expect(cursors.note_created).toEqual({ ts: 200, id: 'n2' });
    // task_created não contribuiu nada — cursor permanece null (não avançou).
    expect(cursors.task_created).toBeNull();
  });

  it('contact_event usa cursor de OFFSET (soma quantos foram consumidos)', () => {
    const batches = emptyBatches();
    batches.contact_event = [item('contact_event', 500, 'c1'), item('contact_event', 400, 'c2')];
    const prev = { ...EMPTY_CURSORS, contact_event: { offset: 10 } };
    const { cursors } = mergeJournalPage(batches, prev, 10);
    expect(cursors.contact_event).toEqual({ offset: 12 });
  });

  it('leftover=true quando sobra item buscado além do que coube na página', () => {
    const batches = emptyBatches();
    batches.note_created = [item('note_created', 300, 'n3'), item('note_created', 200, 'n2'), item('note_created', 100, 'n1')];
    const { items, leftover } = mergeJournalPage(batches, EMPTY_CURSORS, 2);
    expect(items).toHaveLength(2);
    expect(leftover).toBe(true);
  });

  it('paginação completa através de 3 fontes: nenhum item duplica nem falta', () => {
    // 23 itens espalhados entre 3 fontes, timestamps decrescentes intercalados.
    const all: JournalItemView[] = [];
    for (let i = 0; i < 23; i++) {
      const type: SourceKey = (['note_created', 'task_created', 'contact_event'] as const)[i % 3];
      all.push(item(type, 1000 - i, `id${i}`));
    }
    const bySource: Record<SourceKey, JournalItemView[]> = {
      note_created: all.filter((i) => i.type === 'note_created').sort((a, b) => b.ts - a.ts),
      note_updated: [],
      task_created: all.filter((i) => i.type === 'task_created').sort((a, b) => b.ts - a.ts),
      task_completed: [],
      contact_event: all.filter((i) => i.type === 'contact_event').sort((a, b) => b.ts - a.ts),
    };

    // "Banco" simulado por fonte: (ts,id) local usam o cursor real; contact_event usa
    // offset — exatamente o contrato que journal.ts implementa contra D1/proxy real.
    function fetchTsIdSource(list: JournalItemView[], before: { ts: number; id: string } | null, limit: number): JournalItemView[] {
      const eligible = before
        ? list.filter((i) => i.ts < before.ts || (i.ts === before.ts && i.id < before.id))
        : list;
      return eligible.slice(0, limit);
    }
    function fetchOffsetSource(list: JournalItemView[], offset: number, limit: number): JournalItemView[] {
      return list.slice(offset, offset + limit);
    }

    let cursors = EMPTY_CURSORS;
    const seen: string[] = [];
    for (let page = 0; page < 10 && seen.length < 23; page++) {
      const batches: Record<SourceKey, JournalItemView[]> = {
        note_created: fetchTsIdSource(bySource.note_created, cursors.note_created, 5),
        note_updated: [],
        task_created: fetchTsIdSource(bySource.task_created, cursors.task_created, 5),
        task_completed: [],
        contact_event: fetchOffsetSource(bySource.contact_event, cursors.contact_event?.offset ?? 0, 5),
      };
      const merged = mergeJournalPage(batches, cursors, 5);
      if (merged.items.length === 0) break;
      for (const it of merged.items) {
        expect(seen).not.toContain(it.id);
        seen.push(it.id);
      }
      cursors = merged.cursors;
    }
    expect(seen).toHaveLength(23);
    // Ordem global estritamente decrescente por ts (cronológica).
    const tsById = new Map(all.map((i) => [i.id, i.ts]));
    for (let i = 1; i < seen.length; i++) {
      expect(tsById.get(seen[i - 1])!).toBeGreaterThanOrEqual(tsById.get(seen[i])!);
    }
  });
});

describe('renderJournalItems — agrupamento por dia', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2999, 5, 15, 15, 0, 0); // meio-dia BRT de 2999-06-15

  it('mistura notas/tasks/eventos intercalados e agrupa por Hoje/Ontem/data', () => {
    const items: JournalItemView[] = [
      item('note_created', now - 1000, 'today-note'),
      item('task_completed', now - 2000, 'today-task'),
      item('contact_event', now - DAY_MS, 'yesterday-event'),
      item('note_updated', now - 10 * DAY_MS, 'old-note'),
    ];
    const { html } = renderJournalItems(items, now, null);
    const idxToday = html.indexOf('Hoje');
    const idxYesterday = html.indexOf('Ontem');
    const idxTodayNote = html.indexOf('today-note');
    const idxYesterdayEvent = html.indexOf('yesterday-event');
    const idxOldNote = html.indexOf('old-note');
    expect(idxToday).toBeGreaterThanOrEqual(0);
    expect(idxYesterday).toBeGreaterThan(idxToday);
    expect(idxTodayNote).toBeGreaterThan(idxToday);
    expect(idxTodayNote).toBeLessThan(idxYesterday);
    expect(idxYesterdayEvent).toBeGreaterThan(idxYesterday);
    expect(idxOldNote).toBeGreaterThan(idxYesterdayEvent);
  });

  it('carryLabel evita repetir o cabeçalho do dia já mostrado na página anterior', () => {
    const items: JournalItemView[] = [item('note_created', now - 500, 'more-today')];
    const { html, lastLabel } = renderJournalItems(items, now, 'Hoje');
    expect(html).not.toContain('journal-day');
    expect(html).toContain('more-today');
    expect(lastLabel).toBe('Hoje');
  });

  it('itens vazios devolve html vazio e preserva carryLabel', () => {
    const { html, lastLabel } = renderJournalItems([], now, 'Ontem');
    expect(html).toBe('');
    expect(lastLabel).toBe('Ontem');
  });
});

describe('cursorsFromParams / journalUrl — round-trip', () => {
  it('serializa e desserializa os 5 cursores sem perda', () => {
    const cursors = {
      note_created: { ts: 111, id: 'a1' },
      note_updated: { ts: 222, id: 'b2' },
      task_created: { ts: 333, id: 'c3' },
      task_completed: { ts: 444, id: 'd4' },
      contact_event: { offset: 15 },
    };
    const url = journalUrl(cursors);
    const parsed = cursorsFromParams(new URL(`https://x${url}`).searchParams);
    expect(parsed).toEqual(cursors);
  });

  it('sem params → todos os cursores null', () => {
    const parsed = cursorsFromParams(new URLSearchParams());
    expect(parsed).toEqual(EMPTY_CURSORS);
  });
});
