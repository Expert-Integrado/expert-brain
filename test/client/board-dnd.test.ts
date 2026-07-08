// Testes do DnD por Pointer Events do board (src/web/client/board-dnd.ts,
// specs/60-ux-reforma/65) — camada client em jsdom. jsdom não tem PointerEvent
// nem layout real: os eventos são MouseEvent com pointerId/pointerType injetados
// e os retângulos das colunas são mockados via getBoundingClientRect (o seam
// hitTestColumn é puro de propósito).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initBoardDnd, hitTestColumn, type ColumnRect } from '../../src/web/client/board-dnd.js';

function pev(
  type: string,
  opts: { x?: number; y?: number; button?: number; pointerId?: number; pointerType?: string } = {}
): MouseEvent {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    button: opts.button ?? 0,
  });
  Object.defineProperty(e, 'pointerId', { value: opts.pointerId ?? 1 });
  Object.defineProperty(e, 'pointerType', { value: opts.pointerType ?? 'mouse' });
  return e;
}

function setRect(el: HTMLElement, r: { left: number; top: number; right: number; bottom: number }): void {
  el.getBoundingClientRect = () =>
    ({
      ...r,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

// Board com 2 colunas lado a lado: A em x=[0,200], B em x=[220,420], y=[0,600].
// O card fica na coluna A.
function mountBoard() {
  document.body.innerHTML = `
    <div id="task-board" class="task-board">
      <section class="task-col" data-col="col_a">
        <header class="task-col-head"><span class="task-col-label">A</span></header>
        <div class="task-col-body" data-dropzone="col_a">
          <div class="task-card" data-id="t1">
            <a class="task-card-title" href="/app/tasks/t1" draggable="false">Título</a>
            <div class="task-card-actions"><button class="task-btn task-complete" data-id="t1" type="button">✓ concluir</button></div>
          </div>
        </div>
      </section>
      <section class="task-col" data-col="col_b">
        <header class="task-col-head"><span class="task-col-label">B</span></header>
        <div class="task-col-body" data-dropzone="col_b"><div class="task-col-empty">—</div></div>
      </section>
    </div>`;
  const board = document.getElementById('task-board')!;
  const [colA, colB] = Array.from(board.querySelectorAll<HTMLElement>('.task-col'));
  setRect(board, { left: 0, top: 0, right: 440, bottom: 600 });
  setRect(colA, { left: 0, top: 0, right: 200, bottom: 600 });
  setRect(colB, { left: 220, top: 0, right: 420, bottom: 600 });
  const card = board.querySelector<HTMLElement>('.task-card')!;
  setRect(card, { left: 10, top: 10, right: 190, bottom: 90 });
  return { board, card, colA, colB };
}

describe('hitTestColumn (puro)', () => {
  const cols: ColumnRect[] = [
    { id: 'a', left: 0, top: 0, right: 100, bottom: 500 },
    { id: 'b', left: 120, top: 0, right: 220, bottom: 500 },
  ];
  it('devolve o id da coluna que contém o ponto', () => {
    expect(hitTestColumn(50, 250, cols)).toBe('a');
    expect(hitTestColumn(180, 10, cols)).toBe('b');
  });
  it('bordas contam como dentro; fora de tudo devolve null', () => {
    expect(hitTestColumn(100, 0, cols)).toBe('a');
    expect(hitTestColumn(110, 250, cols)).toBeNull();
    expect(hitTestColumn(50, 501, cols)).toBeNull();
  });
});

describe('initBoardDnd', () => {
  let onDrop: ReturnType<typeof vi.fn>;
  let onOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onDrop = vi.fn();
    onOpen = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.body.classList.remove('task-dragging');
    vi.useRealTimers();
  });

  function drag(card: HTMLElement, from: [number, number], to: [number, number]) {
    card.dispatchEvent(pev('pointerdown', { x: from[0], y: from[1] }));
    window.dispatchEvent(pev('pointermove', { x: from[0] + 8, y: from[1] })); // arma (>6px)
    window.dispatchEvent(pev('pointermove', { x: to[0], y: to[1] }));
  }

  it('mouse: mover 6px arma o drag (ghost + .dragging + drag-target na coluna sob o ponteiro)', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    drag(card, [50, 50], [300, 100]); // termina dentro da coluna B
    expect(document.body.classList.contains('task-dragging')).toBe(true);
    expect(card.classList.contains('dragging')).toBe(true);
    expect(document.querySelector('.task-card-ghost')).not.toBeNull();
    expect(board.querySelector('.task-col[data-col="col_b"]')!.classList.contains('drag-target')).toBe(true);
    expect(board.querySelector('.task-col[data-col="col_a"]')!.classList.contains('drag-target')).toBe(false);
    window.dispatchEvent(pev('pointerup', { x: 300, y: 100 }));
  });

  it('drop em coluna diferente chama onDrop e limpa todo o estado visual', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    drag(card, [50, 50], [300, 100]);
    window.dispatchEvent(pev('pointerup', { x: 300, y: 100 }));
    expect(onDrop).toHaveBeenCalledExactlyOnceWith('t1', 'col_b');
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.body.classList.contains('task-dragging')).toBe(false);
    expect(card.classList.contains('dragging')).toBe(false);
    expect(document.querySelector('.task-card-ghost')).toBeNull();
    expect(document.querySelector('.drag-target')).toBeNull();
  });

  it('drop na PRÓPRIA coluna não chama onDrop (no-op, sem POST inútil)', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    drag(card, [50, 50], [100, 300]); // continua dentro da coluna A
    window.dispatchEvent(pev('pointerup', { x: 100, y: 300 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Escape cancela o drag sem drop', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    drag(card, [50, 50], [300, 100]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.body.classList.contains('task-dragging')).toBe(false);
    expect(document.querySelector('.task-card-ghost')).toBeNull();
    // o pointerup que vem depois não pode virar clique
    window.dispatchEvent(pev('pointerup', { x: 300, y: 100 }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('clique simples (sem mover) no corpo do card chama onOpen', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    card.dispatchEvent(pev('pointerdown', { x: 50, y: 50 }));
    card.dispatchEvent(pev('pointerup', { x: 50, y: 50 }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('t1');
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('movimento abaixo do threshold ainda é clique', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    card.dispatchEvent(pev('pointerdown', { x: 50, y: 50 }));
    window.dispatchEvent(pev('pointermove', { x: 53, y: 52 })); // < 6px
    card.dispatchEvent(pev('pointerup', { x: 53, y: 52 }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('t1');
  });

  it('clique em botão interno NÃO navega nem arma drag', () => {
    const { board } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    const btn = board.querySelector<HTMLElement>('.task-complete')!;
    btn.dispatchEvent(pev('pointerdown', { x: 50, y: 80 }));
    btn.dispatchEvent(pev('pointerup', { x: 50, y: 80 }));
    window.dispatchEvent(pev('pointermove', { x: 300, y: 100 }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.body.classList.contains('task-dragging')).toBe(false);
  });

  it('clique no <a> do título deixa a navegação nativa acontecer (onOpen não dispara)', () => {
    const { board } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    const title = board.querySelector<HTMLElement>('.task-card-title')!;
    title.dispatchEvent(pev('pointerdown', { x: 50, y: 20 }));
    title.dispatchEvent(pev('pointerup', { x: 50, y: 20 }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('arrastar PELO título funciona (o <a> não bloqueia o drag)', () => {
    const { board } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    const title = board.querySelector<HTMLElement>('.task-card-title')!;
    title.dispatchEvent(pev('pointerdown', { x: 50, y: 20 }));
    window.dispatchEvent(pev('pointermove', { x: 60, y: 20 }));
    window.dispatchEvent(pev('pointermove', { x: 300, y: 100 }));
    window.dispatchEvent(pev('pointerup', { x: 300, y: 100 }));
    expect(onDrop).toHaveBeenCalledExactlyOnceWith('t1', 'col_b');
  });

  it('touch: long-press de 300ms arma o drag; drop funciona', () => {
    vi.useFakeTimers();
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    card.dispatchEvent(pev('pointerdown', { x: 50, y: 50, pointerType: 'touch' }));
    expect(document.body.classList.contains('task-dragging')).toBe(false);
    vi.advanceTimersByTime(300);
    expect(document.body.classList.contains('task-dragging')).toBe(true);
    window.dispatchEvent(pev('pointermove', { x: 300, y: 100, pointerType: 'touch' }));
    window.dispatchEvent(pev('pointerup', { x: 300, y: 100, pointerType: 'touch' }));
    expect(onDrop).toHaveBeenCalledExactlyOnceWith('t1', 'col_b');
  });

  it('touch: mover antes do long-press é scroll — desarma sem drag nem clique', () => {
    vi.useFakeTimers();
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    card.dispatchEvent(pev('pointerdown', { x: 50, y: 50, pointerType: 'touch' }));
    window.dispatchEvent(pev('pointermove', { x: 50, y: 80, pointerType: 'touch' })); // >10px = scroll
    vi.advanceTimersByTime(400);
    expect(document.body.classList.contains('task-dragging')).toBe(false);
    window.dispatchEvent(pev('pointerup', { x: 50, y: 200, pointerType: 'touch' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('touch: tap rápido (soltar antes dos 300ms) é clique', () => {
    vi.useFakeTimers();
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    card.dispatchEvent(pev('pointerdown', { x: 50, y: 50, pointerType: 'touch' }));
    vi.advanceTimersByTime(100);
    card.dispatchEvent(pev('pointerup', { x: 50, y: 50, pointerType: 'touch' }));
    vi.advanceTimersByTime(400); // o timer do long-press não pode disparar depois
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('t1');
    expect(document.body.classList.contains('task-dragging')).toBe(false);
  });

  it('pointercancel durante o drag cancela sem drop', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    drag(card, [50, 50], [300, 100]);
    window.dispatchEvent(pev('pointercancel', { x: 300, y: 100 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.body.classList.contains('task-dragging')).toBe(false);
    expect(document.querySelector('.task-card-ghost')).toBeNull();
  });

  it('botão não-principal do mouse não arma nada', () => {
    const { board, card } = mountBoard();
    initBoardDnd(board, { onDrop, onOpen });
    card.dispatchEvent(pev('pointerdown', { x: 50, y: 50, button: 2 }));
    card.dispatchEvent(pev('pointerup', { x: 50, y: 50, button: 2 }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
