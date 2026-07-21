// Client da home /app (spec 50-console-v2/65 §2 + rodada 6, 20/07):
// - Quick-complete do card "Hoje" → POST /app/tasks/complete (mesmo endpoint do board).
// - MODO DE EDIÇÃO explícito e transacional (rodada 6, padrão Metabase/Grafana):
//   "Personalizar" liga .home-editing na grid (o CSS revela as alças); os gestos
//   (arrastar pelo título, puxar a borda, toggle de largura, subir/descer,
//   ocultar) SÓ mexem no DOM — nada é persistido por gesto. [Salvar] = 1 POST
//   /app/home/prefs { order, heights, spans, hidden }; [Cancelar] = restaura o
//   snapshot tirado ao entrar; [Restaurar padrão] = POST { reset: true } + reload.
// - Ações inline do card "Pendências com você" (espelho do wirePendingActions do
//   board): fetch + remoção otimista + toast; sem JS o form navega nativo
//   (back=/app traz de volta pra home).
// O feed "Atividade" (spec 69) é responsabilidade do journal.bundle.js.

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
    toast('Não deu pra concluir a tarefa. Tenta de novo.');
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

// ── Modo de edição (rodada 6) ───────────────────────────────────────────────

// Movimento mínimo pra armar o drag — clique parado no título continua clique
// (os links dentro do h2 seguem navegando).
const DRAG_THRESHOLD = 6;

// Bloco de altura do resize (px): o arrasto vertical anda em saltos fixos —
// tamanhos "em bloco", não pixel a pixel (rodada 6.2, pedido do dono).
const HEIGHT_BLOCK = 80;

const editing = (grid: HTMLElement): boolean => grid.classList.contains('home-editing');

// Snapshot do estado visual ao ENTRAR no modo de edição — é o que o Cancelar
// devolve, sem servidor: ordem dos itens, valor de --home-card-h de cada alvo,
// a largura em quartos (home-span-N) e a classe home-card-hidden de cada item.
interface LayoutSnapshot {
  order: HTMLElement[];
  heights: Array<{ el: HTMLElement; value: string }>;
  classes: Array<{ el: HTMLElement; span: number; hidden: boolean }>;
}

// ── Largura em quartos (rodada 6.2): home-span-1..4; span 4 leva o alias
// home-card-wide (CSS legado). Helpers únicos de leitura/escrita da classe. ──
const SPAN_CLASSES = ['home-span-1', 'home-span-2', 'home-span-3', 'home-span-4'];

function currentSpan(item: HTMLElement): number {
  for (let n = 4; n >= 1; n--) if (item.classList.contains('home-span-' + n)) return n;
  return item.classList.contains('home-card-wide') ? 4 : 2;
}

function setSpan(item: HTMLElement, n: number): void {
  const span = Math.min(4, Math.max(1, Math.round(n)));
  for (const c of SPAN_CLASSES) item.classList.remove(c);
  item.classList.add('home-span-' + span);
  item.classList.toggle('home-card-wide', span === 4);
}

function takeSnapshot(grid: HTMLElement): LayoutSnapshot {
  const items = Array.from(grid.querySelectorAll<HTMLElement>('[data-home-item]'))
    .filter((el) => el.parentElement === grid);
  return {
    order: items,
    heights: Array.from(document.querySelectorAll<HTMLElement>('[data-home-box]'))
      .map((el) => ({ el, value: el.style.getPropertyValue('--home-card-h') })),
    classes: items.map((el) => ({
      el,
      span: currentSpan(el),
      hidden: el.classList.contains('home-card-hidden'),
    })),
  };
}

function restoreSnapshot(grid: HTMLElement, snap: LayoutSnapshot): void {
  // Ordem: re-append na sequência salva (append move, não duplica). Card que
  // saiu do DOM durante a edição (ex.: última pendência aprovada removeu o
  // card) fica fora — re-appendar o nó destacado ressuscitaria uma casca vazia.
  for (const el of snap.order) {
    if (el.isConnected) grid.appendChild(el);
  }
  for (const { el, value } of snap.heights) {
    if (!el.isConnected) continue;
    if (value) el.style.setProperty('--home-card-h', value);
    else el.style.removeProperty('--home-card-h');
  }
  for (const { el, span, hidden } of snap.classes) {
    if (!el.isConnected) continue;
    setSpan(el, span);
    el.classList.toggle('home-card-hidden', hidden);
    syncToggleLabels(el);
  }
}

// Lê o layout ATUAL do DOM pro POST em lote do Salvar: ordem = filhos da grid
// com data-home-item; alturas/larguras = só as que diferem do default (chave
// ausente = default, mesma semântica do servidor); hidden = itens com a classe.
function collectLayout(grid: HTMLElement): {
  order: string[];
  heights: Record<string, number>;
  spans: Record<string, number>;
  hidden: string[];
} {
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
  // Largura em quartos: só cards COM controles participam (a Atividade ocupa a
  // linha inteira por CSS e fica de fora). data-home-span-default vem do SSR.
  const spans: Record<string, number> = {};
  grid.querySelectorAll<HTMLElement>('.home-width-controls').forEach((ctl) => {
    const item = ctl.closest<HTMLElement>('[data-home-item]');
    const box = item?.dataset.homeItem;
    if (!item || !box) return;
    const span = currentSpan(item);
    if (span !== Number(ctl.dataset.homeSpanDefault)) spans[box] = span;
  });
  const hidden = Array.from(grid.children)
    .filter((el) => (el as HTMLElement).dataset.homeItem && el.classList.contains('home-card-hidden'))
    .map((el) => (el as HTMLElement).dataset.homeItem as string);
  return { order, heights, spans, hidden };
}

// Re-sincroniza aria-label/title do toggle de ocultar com as classes ATUAIS do
// card — o Cancelar restaura classes por fora dos handlers, e sem isso o botão
// continuaria anunciando o estado descartado. (Os botões de largura ‹ › são
// stateless: sempre "um quarto a menos/a mais".)
function syncToggleLabels(item: HTMLElement): void {
  const hideBtn = item.querySelector<HTMLButtonElement>('[data-home-hide]');
  if (hideBtn) {
    const label = item.classList.contains('home-card-hidden') ? 'Mostrar card' : 'Ocultar card';
    hideBtn.setAttribute('aria-label', label);
    hideBtn.title = label;
  }
}

// Botões ‹ › de LARGURA (rodada 6.2): um quarto a menos/a mais por clique.
// Só mexe no DOM — a persistência é do Salvar.
function wireWidthButtons(grid: HTMLElement): void {
  grid.querySelectorAll<HTMLButtonElement>('[data-home-width]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest<HTMLElement>('[data-home-item]');
      if (!item || !editing(grid)) return;
      setSpan(item, currentSpan(item) + (btn.dataset.homeWidth === 'plus' ? 1 : -1));
    });
  });
}

// Subir/descer (reorder por teclado/touch) + ocultar (olho) — controles novos
// do edit mode (rodada 6). Só DOM; Salvar persiste.
function wireEditControls(grid: HTMLElement): void {
  grid.querySelectorAll<HTMLButtonElement>('[data-home-move]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest<HTMLElement>('[data-home-item]');
      if (!item || item.parentElement !== grid || !editing(grid)) return;
      if (btn.dataset.homeMove === 'up') {
        const prev = item.previousElementSibling;
        if (prev) prev.before(item);
      } else {
        const next = item.nextElementSibling;
        if (next) next.after(item);
      }
      // O foco fica no botão (que viajou junto com o card) — reorder em série
      // por teclado sem re-tab.
      btn.focus();
    });
  });
  grid.querySelectorAll<HTMLButtonElement>('[data-home-hide]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest<HTMLElement>('[data-home-item]');
      if (!item || !editing(grid)) return;
      const nowHidden = item.classList.toggle('home-card-hidden');
      const label = nowHidden ? 'Mostrar card' : 'Ocultar card';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    });
  });
}

// Reordenação por arrasto: ghost segue o ponteiro (o item original fica esmaecido
// no lugar), e a grid reorganiza AO VIVO. Esc cancela e devolve pra posição de origem.
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
    if (!armed) return; // clique sem arrastar: nada a desfazer
    ghost?.remove();
    item.classList.remove('home-box-dragging');
    document.documentElement.classList.remove('home-arranging');
    // Rodada 6: o drop NÃO persiste mais — o layout novo fica no DOM esperando
    // o Salvar (ou morre no Cancelar).
    if (!commit) restore();
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
// Rodada 6: soltar a alça NÃO persiste — só o Salvar.
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
    // Altura em BLOCOS de 80px (rodada 6.2: "escolhe um bloco de pixels e só
    // deixa personalizar nessa estrutura") — o arrasto salta de bloco em bloco.
    const raw = startH + (e.clientY - startY);
    const h = Math.min(max, Math.max(min, Math.round(raw / HEIGHT_BLOCK) * HEIGHT_BLOCK));
    target.style.setProperty('--home-card-h', `${h}px`);
  };
  const onUp = (): void => {
    rz.removeEventListener('pointermove', onMove);
    rz.removeEventListener('pointerup', onUp);
    rz.removeEventListener('pointercancel', onUp);
    rz.classList.remove('active');
  };
  rz.addEventListener('pointermove', onMove);
  rz.addEventListener('pointerup', onUp);
  rz.addEventListener('pointercancel', onUp);
}

// Alça LATERAL (rodada 6.3, "não dá para arrastar para os lados"): barrinha na
// borda direita do card arrasta a LARGURA com snap por quarto do grid (1..4).
function startResizeWidth(rz: HTMLElement, item: HTMLElement, down: PointerEvent): void {
  down.preventDefault();
  const startX = down.clientX;
  const quarter = (item.parentElement?.getBoundingClientRect().width ?? 0) / 4;
  const startSpan = currentSpan(item);
  rz.classList.add('active');
  if (typeof rz.setPointerCapture === 'function') {
    try { rz.setPointerCapture(down.pointerId); } catch { /* noop */ }
  }
  const onMove = (e: PointerEvent): void => {
    if (quarter > 0) setSpan(item, startSpan + Math.round((e.clientX - startX) / quarter));
  };
  const onUp = (): void => {
    rz.removeEventListener('pointermove', onMove);
    rz.removeEventListener('pointerup', onUp);
    rz.removeEventListener('pointercancel', onUp);
    rz.classList.remove('active');
  };
  rz.addEventListener('pointermove', onMove);
  rz.addEventListener('pointerup', onUp);
  rz.addEventListener('pointercancel', onUp);
}

function wireArrange(): void {
  const grid = document.querySelector<HTMLElement>('.home-grid');
  if (!grid) return;
  wireWidthButtons(grid);
  wireEditControls(grid);

  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Gestos de layout só existem no modo de edição (rodada 6) — em view mode
    // o título é título e a borda é borda.
    if (!editing(grid)) return;
    const el = e.target as HTMLElement;

    const rzw = el.closest<HTMLElement>('.home-resize-w');
    if (rzw) {
      const container = rzw.closest<HTMLElement>('[data-home-item]');
      if (container && container.querySelector('.home-width-controls')) startResizeWidth(rzw, container, e);
      return;
    }

    const rz = el.closest<HTMLElement>('.home-resize');
    if (rz) {
      const container = rz.closest<HTMLElement>('[data-home-item]');
      const target = container?.matches('[data-home-box]')
        ? container
        : container?.querySelector<HTMLElement>('[data-home-box]');
      if (target) startResize(rz, target, e);
      return;
    }

    // Rodada 6.1: em edição o card INTEIRO arrasta — o título era alvo pequeno
    // demais. Links, botões e forms continuam clicáveis (drag só arma com
    // movimento, e pointerdown neles é ignorado).
    if (el.closest('a, button, input, textarea, select, form')) return;
    const item = el.closest<HTMLElement>('[data-home-item]');
    if (!item || item.parentElement !== grid) return;
    startDrag(grid, item, e);
  });

  wireEditMode(grid);
}

// Liga/desliga o modo + barra Salvar/Cancelar/Restaurar padrão (rodada 6).
function wireEditMode(grid: HTMLElement): void {
  const toggle = document.getElementById('home-edit-toggle') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('home-edit-save') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('home-edit-cancel') as HTMLButtonElement | null;
  const resetBtn = document.getElementById('home-edit-reset') as HTMLButtonElement | null;
  if (!toggle) return;

  let snapshot: LayoutSnapshot | null = null;

  const enter = (): void => {
    snapshot = takeSnapshot(grid);
    // Prima --home-card-h com o default onde não há altura salva: em edição a
    // altura é REAL (min-height no CSS) e todo card responde à alça, inclusive
    // os de conteúdo curto. O collectLayout descarta o que for igual ao default
    // e o Cancelar devolve o inline original do snapshot.
    document.querySelectorAll<HTMLElement>('[data-home-box]').forEach((el) => {
      if (!el.style.getPropertyValue('--home-card-h') && el.dataset.homeDefault) {
        el.style.setProperty('--home-card-h', `${el.dataset.homeDefault}px`);
      }
    });
    grid.classList.add('home-editing');
    toggle.setAttribute('aria-pressed', 'true');
  };
  const exit = (): void => {
    grid.classList.remove('home-editing');
    toggle.setAttribute('aria-pressed', 'false');
    snapshot = null;
  };
  const cancel = (): void => {
    if (snapshot) restoreSnapshot(grid, snapshot);
    exit();
  };

  toggle.addEventListener('click', () => {
    // Clicar no lápis com o modo LIGADO = sair sem salvar (mesmo que Cancelar).
    if (editing(grid)) cancel();
    else enter();
  });
  cancelBtn?.addEventListener('click', cancel);

  saveBtn?.addEventListener('click', () => {
    void (async () => {
      saveBtn.disabled = true;
      try {
        const res = await appFetch('/app/home/prefs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // sizes:{} LIMPA o legado normal|wide no servidor — depois do 1o Salvar
          // do modelo de quartos, spans é a única verdade de largura (senão um
          // wide antigo ressuscitaria quando o span voltasse ao default).
          body: JSON.stringify({ ...collectLayout(grid), sizes: {} }),
        });
        if (!res.ok) throw new Error(`prefs ${res.status}`);
        toast('Layout salvo.', 'ok');
        exit();
      } catch (err) {
        console.warn('home: prefs save failed', err);
        toast('Não deu pra salvar o layout. Tente de novo.');
      } finally {
        saveBtn.disabled = false;
      }
    })();
  });

  resetBtn?.addEventListener('click', () => {
    void (async () => {
      resetBtn.disabled = true;
      try {
        const res = await appFetch('/app/home/prefs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reset: true }),
        });
        if (!res.ok) throw new Error(`prefs ${res.status}`);
        // Reload: o SSR remonta tudo no default (o dismiss do "Comece aqui"
        // sobrevive por contrato do endpoint).
        location.reload();
      } catch (err) {
        console.warn('home: prefs reset failed', err);
        toast('Não deu pra restaurar o padrão. Tente de novo.');
        resetBtn.disabled = false;
      }
    })();
  });
}

// ── Ações inline do card "Pendências com você" (rodada 6) ───────────────────
// Recalcula o contador do cabeçalho ("· N — X perguntas, Y para aprovar") e o
// "Ver mais (N)" a partir dos itens que SOBRARAM no DOM — a remoção otimista
// não pode deixar o número velho no h2 (a home não tem o poll do board).
// Mesma redação de pendingKindsLabel (src/web/pending.ts).
function refreshPendingCount(card: HTMLElement): void {
  const items = card.querySelectorAll<HTMLElement>('.task-pending-item');
  const q = Array.from(items).filter((el) => el.dataset.kind === 'question').length;
  const a = items.length - q;
  const kinds: string[] = [];
  if (q > 0) kinds.push(`${q} pergunta${q === 1 ? '' : 's'}`);
  if (a > 0) kinds.push(`${a} para aprovar`);
  const count = card.querySelector<HTMLElement>('.home-pending-count');
  if (count) count.textContent = `· ${items.length} — ${kinds.join(', ')}`;
  const more = card.querySelector<HTMLElement>('.task-pending-more');
  if (more) {
    const rest = more.querySelectorAll('.task-pending-item').length;
    if (rest === 0) more.remove();
    else {
      const summary = more.querySelector('summary');
      if (summary) summary.textContent = `Ver mais (${rest})`;
    }
  }
}

// Espelho do wirePendingActions do board (src/web/client/tasks.ts): submit
// delegado nos forms data-pending-form do card, fetch + remoção OTIMISTA do
// item + toast. Sem JS o form navega nativo e o back=/app traz de volta.
function wirePendingActions(): void {
  const card = document.querySelector<HTMLElement>('[data-home-item="pending"]');
  if (!card) return;
  card.addEventListener('submit', (e) => {
    const form = e.target instanceof HTMLFormElement ? e.target : null;
    if (!form || !form.hasAttribute('data-pending-form')) return;
    e.preventDefault();
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    const fd = new FormData(form);
    // FormData não carrega o botão que submeteu — approve/return viajam por ele.
    if (submitter?.name) fd.set(submitter.name, submitter.value);
    const kind = form.dataset.pendingKind;
    const action = submitter?.value ?? '';
    const buttons = Array.from(form.querySelectorAll('button'));
    buttons.forEach((b) => { b.disabled = true; });
    void (async () => {
      try {
        const res = await appFetch(form.getAttribute('action') || '', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('pending ' + res.status);
        toast(
          kind === 'question'
            ? 'Resposta enviada — o agente foi liberado pra continuar.'
            : action === 'approve'
              ? 'Entrega aprovada e concluída.'
              : 'Entrega devolvida pra execução.',
          'ok'
        );
        // Remoção otimista: o item sai da fila na hora; a fila esvaziou = o
        // card inteiro some (mesmo contrato do SSR: vazio não renderiza).
        form.closest('.task-pending-item')?.remove();
        if (!card.querySelector('.task-pending-item')) card.remove();
        else refreshPendingCount(card);
      } catch (err) {
        console.warn('home: ação de pendência falhou', err);
        toast('Não deu pra concluir a ação — tenta de novo.');
        buttons.forEach((b) => { b.disabled = false; });
      }
    })();
  });
}

wireToday();
wireArrange();
wirePendingActions();
