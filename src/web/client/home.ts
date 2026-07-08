// Client da home /app (spec 50-console-v2/65 §2):
// - Quick-complete do card "Hoje" → POST /app/tasks/complete (mesmo endpoint do board).
// - Manipulação direta das caixas (Onda 9b, spec 72 — "igual ao ClickUp"):
//   arrastar pelo TÍTULO (.home-box-handle) reordena os filhos da .home-grid ao
//   vivo; puxar a BORDA DE BAIXO (.home-resize) redimensiona o alvo [data-home-box].
//   Persistência única no fim do gesto: POST /app/home/prefs { order, heights }.
// O feed "Atividade" (spec 69) é responsabilidade do journal.bundle.js, também
// incluído na home — o antigo card "Últimas interações" foi absorvido pelo feed.

import { appFetch } from './http.js';
import { toast } from './toast.js';

async function completeTask(id: string, li: HTMLLIElement): Promise<void> {
  try {
    const res = await appFetch('/app/tasks/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error('complete ' + res.status);
    const list = li.parentElement;
    li.remove();
    if (list && list.children.length === 0) {
      list.outerHTML = '<p class="home-empty">Nada vencendo nas próximas 24h.</p>';
    }
  } catch (err) {
    console.warn('home: complete failed', err);
  }
}

function wireToday(): void {
  document.querySelectorAll<HTMLButtonElement>('.home-task-complete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const li = btn.closest('li');
      if (id && li) void completeTask(id, li);
    });
  });
}

// ── Manipulação direta (Onda 9b, spec 72) ───────────────────────────────────

// Movimento mínimo pra armar o drag — clique parado no título continua clique
// (os links dentro do h2 seguem navegando).
const DRAG_THRESHOLD = 6;

// Lê o layout ATUAL do DOM e persiste: ordem = filhos da grid com data-home-item;
// alturas = só as que diferem do default (chave ausente = default, mesma semântica
// do servidor). Chamada UMA vez no fim do gesto (drop/solta da borda), nunca durante.
async function persistLayout(grid: HTMLElement): Promise<void> {
  const order = Array.from(grid.children)
    .map((el) => (el as HTMLElement).dataset.homeItem)
    .filter((k): k is string => !!k);
  const heights: Record<string, number> = {};
  document.querySelectorAll<HTMLElement>('[data-home-box]').forEach((el) => {
    const box = el.dataset.homeBox || '';
    const px = parseInt(el.style.getPropertyValue('--home-card-h'), 10);
    if (!box || Number.isNaN(px)) return;
    if (px !== Number(el.dataset.homeDefault)) heights[box] = px;
  });
  try {
    const res = await appFetch('/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order, heights }),
    });
    if (!res.ok) throw new Error(`prefs ${res.status}`);
  } catch (err) {
    console.warn('home: prefs save failed', err);
    toast('Não deu pra salvar o layout. Tente de novo.');
  }
}

// Reordenação: ghost segue o ponteiro (o item original fica esmaecido no lugar),
// e a grid reorganiza AO VIVO — o item é movido pra posição do alvo sob o ponteiro
// (before/after conforme a direção). Esc cancela e devolve pra posição de origem.
function startDrag(grid: HTMLElement, item: HTMLElement, down: PointerEvent): void {
  const startX = down.clientX;
  const startY = down.clientY;
  const prevAtStart = item.previousElementSibling;
  let armed = false;
  let offX = 0;
  let offY = 0;
  let ghost: HTMLElement | null = null;

  const arm = (): void => {
    armed = true;
    const r = item.getBoundingClientRect();
    offX = startX - r.left;
    offY = startY - r.top;
    ghost = item.cloneNode(true) as HTMLElement;
    ghost.classList.add('home-box-ghost');
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    document.body.appendChild(ghost);
    item.classList.add('home-box-dragging');
    document.documentElement.classList.add('home-arranging');
  };

  const restore = (): void => {
    // Só o item se move durante o gesto, então o vizinho de origem ainda ancora
    // a posição inicial.
    if (prevAtStart && prevAtStart.parentElement === grid) prevAtStart.after(item);
    else grid.prepend(item);
  };

  const onMove = (e: PointerEvent): void => {
    if (!armed) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      arm();
    }
    if (ghost) {
      ghost.style.left = `${e.clientX - offX}px`;
      ghost.style.top = `${e.clientY - offY}px`;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under?.closest<HTMLElement>('[data-home-item]');
    if (!target || target === item || target.parentElement !== grid) return;
    const kids = Array.from(grid.children);
    if (kids.indexOf(item) < kids.indexOf(target)) target.after(item);
    else target.before(item);
  };

  const finish = (commit: boolean): void => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('keydown', onKey);
    if (!armed) return; // clique sem arrastar: nada a desfazer nem salvar
    ghost?.remove();
    item.classList.remove('home-box-dragging');
    document.documentElement.classList.remove('home-arranging');
    if (commit) void persistLayout(grid);
    else restore();
  };

  const onUp = (): void => finish(true);
  const onCancel = (): void => finish(false);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') finish(false);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onCancel);
  document.addEventListener('keydown', onKey);
}

// Redimensionamento: a alça vive no ITEM, mas o alvo de altura é o elemento com
// data-home-box (no card é o próprio; na Atividade é a caixa interna do feed).
function startResize(rz: HTMLElement, target: HTMLElement, down: PointerEvent): void {
  down.preventDefault();
  const startY = down.clientY;
  const fallback = Number(target.dataset.homeDefault) || 420;
  const startH = parseInt(getComputedStyle(target).maxHeight, 10) || fallback;
  const min = Number(target.dataset.homeMin) || 220;
  const max = Number(target.dataset.homeMax) || 960;
  rz.classList.add('active');
  // Captura mantém o gesto vivo mesmo com o ponteiro fora da alça (guardado:
  // jsdom não implementa Pointer Capture).
  if (typeof rz.setPointerCapture === 'function') {
    try { rz.setPointerCapture(down.pointerId); } catch { /* noop */ }
  }

  const onMove = (e: PointerEvent): void => {
    const h = Math.min(max, Math.max(min, Math.round(startH + (e.clientY - startY))));
    target.style.setProperty('--home-card-h', `${h}px`);
  };
  const onUp = (): void => {
    rz.removeEventListener('pointermove', onMove);
    rz.removeEventListener('pointerup', onUp);
    rz.removeEventListener('pointercancel', onUp);
    rz.classList.remove('active');
    const grid = document.querySelector<HTMLElement>('.home-grid');
    if (grid) void persistLayout(grid);
  };
  rz.addEventListener('pointermove', onMove);
  rz.addEventListener('pointerup', onUp);
  rz.addEventListener('pointercancel', onUp);
}

function wireArrange(): void {
  const grid = document.querySelector<HTMLElement>('.home-grid');
  if (!grid) return;

  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;

    const rz = el.closest<HTMLElement>('.home-resize');
    if (rz) {
      const container = rz.closest<HTMLElement>('[data-home-item]');
      const target = container?.matches('[data-home-box]')
        ? container
        : container?.querySelector<HTMLElement>('[data-home-box]');
      if (target) startResize(rz, target, e);
      return;
    }

    const handle = el.closest<HTMLElement>('.home-box-handle');
    if (!handle) return;
    // Links dentro do título continuam clicáveis — drag só arma com movimento.
    if (el.closest('a, button, input, form')) return;
    const item = handle.closest<HTMLElement>('[data-home-item]');
    if (!item || item.parentElement !== grid) return;
    startDrag(grid, item, e);
  });
}

wireToday();
wireArrange();
