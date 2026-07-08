// DnD do Kanban por Pointer Events (spec 60-ux-reforma/65, Onda 4).
//
// Substitui o HTML5 drag-and-drop antigo, que não funcionava em touch e pintava a
// coluna inteira de lavanda. State machine: idle → armed → dragging → dropped/
// cancelado. Regras:
// - armar o drag: mover 6px (mouse/pen) OU segurar 300ms parado (touch);
// - touch que se move antes do long-press é SCROLL — desarma e deixa a página rolar;
// - ghost: clone do card com pointer-events:none seguindo o ponteiro;
// - alvo: classe .drag-target na <section class="task-col"> (borda + header acendem,
//   nunca fundo pintado — o CSS vive em TASKS_CSS);
// - autoscroll: bordas horizontais do #task-board (e verticais da janela) rolam
//   sozinhas enquanto o ponteiro fica na faixa da borda;
// - delegação: UM pointerdown no container — sobrevive aos re-renders do board;
// - clique: pointerup sem drag armado abre o detalhe da task (card inteiro
//   clicável). Exceções: controles internos (button/input/select/textarea/label/
//   painel de quick-edit) cuidam de si; o <a> do título navega nativo; seleção de
//   texto dentro do card não navega.
//
// Seam pra jsdom: hitTestColumn() é pura (recebe retângulos, devolve o id da
// coluna) — getBoundingClientRect é sempre 0x0 no jsdom, então os testes passam
// os retângulos na mão.

export interface ColumnRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BoardDndCallbacks {
  /** Card solto numa coluna DIFERENTE da de origem. */
  onDrop(cardId: string, columnId: string): void;
  /** Clique simples no corpo do card (fora de link/controle). */
  onOpen(cardId: string): void;
}

const DRAG_THRESHOLD_PX = 6; // mouse/pen: distância que arma o drag
const LONG_PRESS_MS = 300; // touch: segurar parado arma o drag
const TOUCH_SLOP_PX = 10; // touch: mexer além disso antes do long-press = scroll
const AUTOSCROLL_EDGE_PX = 48; // faixa da borda que ativa autoscroll
const AUTOSCROLL_MAX_PX = 14; // velocidade máxima por frame

export function hitTestColumn(x: number, y: number, cols: ColumnRect[]): string | null {
  for (const c of cols) {
    if (x >= c.left && x <= c.right && y >= c.top && y <= c.bottom) return c.id;
  }
  return null;
}

// Controles internos do card que NUNCA armam drag nem viram clique-de-card.
// O <a> do título fica de fora de propósito: arrastar segurando o título precisa
// funcionar (é a maior área do card); no clique simples ele navega nativo.
const CONTROL_SELECTOR = 'button, input, select, textarea, label, .task-card-edit';

type Phase =
  | { name: 'idle' }
  | {
      name: 'armed';
      card: HTMLElement;
      pointerId: number;
      startX: number;
      startY: number;
      isTouch: boolean;
      timer: number | null; // long-press (só touch)
    }
  | {
      name: 'dragging';
      card: HTMLElement;
      pointerId: number;
      ghost: HTMLElement;
      grabDX: number; // offset do ponteiro pro canto do card no grab
      grabDY: number;
      lastX: number;
      lastY: number;
      raf: number;
      target: string | null; // coluna sob o ponteiro agora
    };

export function initBoardDnd(board: HTMLElement, cb: BoardDndCallbacks): void {
  let phase: Phase = { name: 'idle' };
  let suppressNextClick = false;

  // Non-passive: depois que o long-press arma o drag, segura o scroll nativo que
  // o navegador ainda tentaria iniciar (padrão SortableJS/Shopify Draggable).
  const preventTouchScroll = (e: TouchEvent) => {
    if (phase.name === 'dragging') e.preventDefault();
  };

  function columnRects(): ColumnRect[] {
    return Array.from(board.querySelectorAll<HTMLElement>('.task-col')).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.col || '', left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
  }

  function clearTarget(): void {
    board.querySelectorAll('.task-col.drag-target').forEach((el) => el.classList.remove('drag-target'));
  }

  function setTarget(colId: string | null): void {
    clearTarget();
    if (!colId) return;
    // CSS.escape nem sempre existe (jsdom); ids de coluna são [a-z0-9_-], o
    // fallback só blinda aspas por segurança.
    const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(colId) : colId.replace(/["\\]/g, '\\$&');
    board.querySelector(`.task-col[data-col="${safe}"]`)?.classList.add('drag-target');
  }

  function removeWindowListeners(): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  }

  function cancelArmed(): void {
    if (phase.name !== 'armed') return;
    if (phase.timer !== null) clearTimeout(phase.timer);
    phase = { name: 'idle' };
    removeWindowListeners();
  }

  function startDrag(armed: Extract<Phase, { name: 'armed' }>, x: number, y: number): void {
    if (armed.timer !== null) clearTimeout(armed.timer);
    const rect = armed.card.getBoundingClientRect();
    const ghost = armed.card.cloneNode(true) as HTMLElement;
    ghost.classList.add('task-card-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);

    armed.card.classList.add('dragging');
    document.body.classList.add('task-dragging');
    if (armed.isTouch) document.addEventListener('touchmove', preventTouchScroll, { passive: false });

    const dragging: Extract<Phase, { name: 'dragging' }> = {
      name: 'dragging',
      card: armed.card,
      pointerId: armed.pointerId,
      ghost,
      grabDX: x - rect.left,
      grabDY: y - rect.top,
      lastX: x,
      lastY: y,
      raf: 0,
      target: null,
    };
    phase = dragging;
    positionGhost(x, y);
    dragging.target = hitTestColumn(x, y, columnRects());
    setTarget(dragging.target);
    dragging.raf = requestAnimationFrame(autoscrollStep);
  }

  function positionGhost(x: number, y: number): void {
    if (phase.name !== 'dragging') return;
    phase.ghost.style.left = `${x - phase.grabDX}px`;
    phase.ghost.style.top = `${y - phase.grabDY}px`;
  }

  // Autoscroll em rAF (não no pointermove): segurar o ponteiro PARADO na borda
  // precisa continuar rolando. Horizontal no board (overflow-x), vertical na janela.
  function autoscrollStep(): void {
    if (phase.name !== 'dragging') return;
    const br = board.getBoundingClientRect();
    const x = phase.lastX;
    const y = phase.lastY;
    let dx = 0;
    if (x < br.left + AUTOSCROLL_EDGE_PX) dx = -Math.min(AUTOSCROLL_MAX_PX, Math.ceil((br.left + AUTOSCROLL_EDGE_PX - x) / 4));
    else if (x > br.right - AUTOSCROLL_EDGE_PX) dx = Math.min(AUTOSCROLL_MAX_PX, Math.ceil((x - (br.right - AUTOSCROLL_EDGE_PX)) / 4));
    if (dx) board.scrollLeft += dx;
    let dy = 0;
    if (y < AUTOSCROLL_EDGE_PX) dy = -Math.min(AUTOSCROLL_MAX_PX, Math.ceil((AUTOSCROLL_EDGE_PX - y) / 4));
    else if (y > window.innerHeight - AUTOSCROLL_EDGE_PX) dy = Math.min(AUTOSCROLL_MAX_PX, Math.ceil((y - (window.innerHeight - AUTOSCROLL_EDGE_PX)) / 4));
    if (dy) window.scrollBy(0, dy);
    if (dx || dy) {
      // A rolagem mexeu as colunas sob o ponteiro parado — reavalia o alvo.
      const t = hitTestColumn(phase.lastX, phase.lastY, columnRects());
      if (t !== phase.target) {
        phase.target = t;
        setTarget(t);
      }
    }
    phase.raf = requestAnimationFrame(autoscrollStep);
  }

  function finishDrag(drop: boolean): void {
    if (phase.name !== 'dragging') return;
    const { card, ghost, raf, target } = phase;
    cancelAnimationFrame(raf);
    ghost.remove();
    card.classList.remove('dragging');
    document.body.classList.remove('task-dragging');
    document.removeEventListener('touchmove', preventTouchScroll);
    clearTarget();
    removeWindowListeners();
    phase = { name: 'idle' };

    // O click nativo que o navegador dispara logo após o pointerup do drop não
    // pode navegar (o ponteiro pode soltar em cima do <a> de outro card).
    suppressNextClick = true;
    setTimeout(() => {
      suppressNextClick = false;
    }, 0);

    const cardId = card.dataset.id || '';
    const sourceCol = card.closest<HTMLElement>('.task-col')?.dataset.col || null;
    if (drop && target && cardId && target !== sourceCol) cb.onDrop(cardId, target);
  }

  function onMove(e: PointerEvent): void {
    if (phase.name === 'armed') {
      if (e.pointerId !== phase.pointerId) return;
      const dist = Math.hypot(e.clientX - phase.startX, e.clientY - phase.startY);
      if (phase.isTouch) {
        // Mexeu antes do long-press = intenção de scroll; sai da frente.
        if (dist > TOUCH_SLOP_PX) cancelArmed();
      } else if (dist >= DRAG_THRESHOLD_PX) {
        startDrag(phase, e.clientX, e.clientY);
      }
      return;
    }
    if (phase.name === 'dragging') {
      if (e.pointerId !== phase.pointerId) return;
      if (e.cancelable) e.preventDefault();
      phase.lastX = e.clientX;
      phase.lastY = e.clientY;
      positionGhost(e.clientX, e.clientY);
      const t = hitTestColumn(e.clientX, e.clientY, columnRects());
      if (t !== phase.target) {
        phase.target = t;
        setTarget(t);
      }
    }
  }

  function onUp(e: PointerEvent): void {
    if (phase.name === 'armed') {
      if (e.pointerId !== phase.pointerId) return;
      const card = phase.card;
      cancelArmed();
      // Clique simples. O <a> do título navega nativo (preserva ctrl/cmd+click e
      // botão do meio); o resto do card navega via callback.
      const t = e.target as Element | null;
      if (t && t.closest && t.closest('a')) return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && sel.anchorNode && card.contains(sel.anchorNode)) return;
      const id = card.dataset.id;
      if (id) cb.onOpen(id);
      return;
    }
    if (phase.name === 'dragging') {
      if (e.pointerId !== phase.pointerId) return;
      finishDrag(true);
    }
  }

  function onCancel(e: PointerEvent): void {
    if (phase.name === 'armed' && e.pointerId === phase.pointerId) cancelArmed();
    else if (phase.name === 'dragging' && e.pointerId === phase.pointerId) finishDrag(false);
  }

  board.addEventListener('pointerdown', (e: PointerEvent) => {
    if (phase.name !== 'idle') return;
    if (e.button !== 0) return; // só botão principal / toque
    const t = e.target as Element | null;
    const card = t && t.closest ? t.closest<HTMLElement>('.task-card') : null;
    if (!card || !board.contains(card)) return;
    if (t && t.closest(CONTROL_SELECTOR)) return;
    const armed: Extract<Phase, { name: 'armed' }> = {
      name: 'armed',
      card,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      isTouch: e.pointerType === 'touch',
      timer: null,
    };
    if (armed.isTouch) {
      armed.timer = window.setTimeout(() => {
        if (phase === armed) startDrag(armed, armed.startX, armed.startY);
      }, LONG_PRESS_MS);
    }
    phase = armed;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });

  // Suprime o click fantasma pós-drop (fase de captura, antes de qualquer handler).
  board.addEventListener(
    'click',
    (e) => {
      if (suppressNextClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextClick = false;
      }
    },
    true
  );

  // Esc cancela o drag em andamento; long-press no touch não vira menu de contexto.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && phase.name === 'dragging') finishDrag(false);
  });
  board.addEventListener('contextmenu', (e) => {
    if (phase.name === 'dragging' || (phase.name === 'armed' && phase.isTouch)) e.preventDefault();
  });
}
