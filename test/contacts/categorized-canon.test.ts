import { describe, it, expect } from 'vitest';
import {
  EVENT_KINDS, EVENT_SOURCES, EVENT_KIND_LABELS,
  MANUAL_EVENT_KINDS, LAST_CONTACTED_EVENT_KINDS,
} from '../../src/contacts/canon';
import { eventKindReembeds } from '../../src/contacts/embedding';

// Spec 40-ops/45 — invariantes do kind 'categorized' (trilha de proveniência de
// categorização em massa) e do source 'seed'. O kind existe pra registrar QUEM
// categorizou sem os efeitos colaterais de uma interação real: um apply de 1451
// seeds não pode disparar 1451 reembeds nem "tocar" last_contacted de todo mundo.

describe('canon: categorized/seed (spec 40-ops/45)', () => {
  it("'categorized' é EVENT_KIND válido com label PT-BR", () => {
    expect(EVENT_KINDS).toContain('categorized');
    expect(EVENT_KIND_LABELS.categorized).toBe('Categorização');
  });

  it("'seed' é EVENT_SOURCE válido", () => {
    expect(EVENT_SOURCES).toContain('seed');
  });

  it("'categorized' NÃO aparece no form manual da UI", () => {
    expect(MANUAL_EVENT_KINDS).not.toContain('categorized');
  });

  it("'categorized' NÃO atualiza last_contacted (não é contato real)", () => {
    expect(LAST_CONTACTED_EVENT_KINDS).not.toContain('categorized');
  });

  it("'categorized' NÃO reembeda a entidade (só 'note' reembeda)", () => {
    expect(eventKindReembeds('categorized')).toBe(false);
    expect(eventKindReembeds('note')).toBe(true);
  });

  it('todo EVENT_KIND tem label de exibição', () => {
    for (const kind of EVENT_KINDS) {
      expect(EVENT_KIND_LABELS[kind], `label ausente pro kind '${kind}'`).toBeTruthy();
    }
  });
});
