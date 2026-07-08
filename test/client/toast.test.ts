// Testes do toast compartilhado dos bundles (src/web/client/toast.ts) — o
// primeiro teste da camada client (specs/60-ux-reforma/61). Cobre criação
// única do elemento, troca de mensagem/kind e autodismiss.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from '../../src/web/client/toast.js';

describe('toast', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  it('cria uma div .app-toast com aria-live e a mensagem', () => {
    toast('salvou', 'ok');
    const el = document.querySelector('.app-toast') as HTMLDivElement;
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('salvou');
    expect(el.dataset.kind).toBe('ok');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.classList.contains('is-visible')).toBe(true);
  });

  it('reusa o mesmo elemento em chamadas seguidas (uma mensagem por vez)', () => {
    toast('primeira');
    toast('segunda', 'error');
    const els = document.querySelectorAll('.app-toast');
    expect(els.length).toBe(1);
    expect(els[0].textContent).toBe('segunda');
    expect((els[0] as HTMLElement).dataset.kind).toBe('error');
  });

  it('esconde após 4s (autodismiss) e reseta o timer a cada chamada', () => {
    toast('a');
    vi.advanceTimersByTime(3000);
    toast('b'); // reseta o timer
    vi.advanceTimersByTime(3000);
    const el = document.querySelector('.app-toast') as HTMLDivElement;
    expect(el.classList.contains('is-visible')).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(el.classList.contains('is-visible')).toBe(false);
  });

  it('default de kind é error', () => {
    toast('deu ruim');
    const el = document.querySelector('.app-toast') as HTMLDivElement;
    expect(el.dataset.kind).toBe('error');
  });
});
