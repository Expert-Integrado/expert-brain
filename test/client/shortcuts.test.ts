// Cheatsheet de atalhos (src/web/client/shortcuts.ts, spec 91/97) em jsdom.
// Fonte única: o modal é GERADO da mesma lista que alimenta os binds do shell —
// atalho novo entra na lista e aparece na ajuda de graça.
import { describe, it, expect } from 'vitest';
import { SHORTCUT_DEFS, isTypingTarget, shortcutsModalHtml } from '../../src/web/client/shortcuts.js';

describe('SHORTCUT_DEFS (fonte única)', () => {
  it('cobre os binds existentes do shell (Ctrl+K/G/N/T/B/,) e o próprio ?', () => {
    const combos = SHORTCUT_DEFS.map((s) => s.combo);
    for (const c of ['Ctrl+K', 'Ctrl+G', 'Ctrl+N', 'Ctrl+T', 'Ctrl+B', 'Ctrl+,', '?']) {
      expect(combos).toContain(c);
    }
  });

  it('todo atalho da lista aparece no modal (nada mantido à mão)', () => {
    const html = shortcutsModalHtml(false);
    for (const s of SHORTCUT_DEFS) {
      expect(html).toContain(s.desc);
    }
    expect(html).toContain('Ctrl+K');
  });

  it('no Mac, Ctrl vira ⌘ no rótulo', () => {
    const html = shortcutsModalHtml(true);
    expect(html).toContain('⌘');
    expect(html).not.toContain('Ctrl+K');
  });
});

describe('isTypingTarget (filtro do "?")', () => {
  it('input, textarea e contenteditable bloqueiam o atalho', () => {
    const input = document.createElement('input');
    const ta = document.createElement('textarea');
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    document.body.append(input, ta, ce);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(ta)).toBe(true);
    expect(isTypingTarget(ce)).toBe(true);
  });

  it('body e botão não bloqueiam', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(btn)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
