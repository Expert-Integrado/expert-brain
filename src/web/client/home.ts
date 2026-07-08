// Client da home /app (spec 50-console-v2/65 §2):
// - Quick-complete do card "Hoje" → POST /app/tasks/complete (mesmo endpoint do board).
// - Modal "Ajustar caixas" (Onda 9, spec 71): sliders com preview ao vivo na
//   custom property --home-card-h de cada caixa, persistência em POST /app/home/prefs.
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

// Modal "Ajustar caixas" (Onda 9): slider por caixa, preview AO VIVO (aplica a
// custom property direto no elemento), salvar persiste no servidor (vale em todas
// as máquinas do dono). Fechar sem salvar (backdrop/✕/Esc) reverte o preview.
function wirePrefs(): void {
  const modal = document.getElementById('home-prefs-modal');
  const openBtn = document.getElementById('home-prefs-open');
  if (!modal || !openBtn) return;
  const ranges = Array.from(modal.querySelectorAll<HTMLInputElement>('.home-prefs-range'));

  const applyBox = (box: string, px: number): void => {
    document.querySelector<HTMLElement>(`[data-home-box="${box}"]`)?.style.setProperty('--home-card-h', `${px}px`);
  };
  const sync = (r: HTMLInputElement): void => {
    const box = r.dataset.box || '';
    applyBox(box, Number(r.value));
    const span = modal.querySelector(`[data-val-for="${box}"]`);
    if (span) span.textContent = `${r.value}px`;
  };

  let initial: Record<string, string> = {};
  const open = (): void => {
    initial = {};
    for (const r of ranges) initial[r.dataset.box || ''] = r.value;
    modal.hidden = false;
  };
  const close = (revert: boolean): void => {
    if (revert) {
      for (const r of ranges) {
        const prev = initial[r.dataset.box || ''];
        if (prev !== undefined && prev !== r.value) { r.value = prev; sync(r); }
      }
    }
    modal.hidden = true;
  };

  openBtn.addEventListener('click', open);
  modal.querySelector('.modal-backdrop')?.addEventListener('click', () => close(true));
  modal.querySelector('.modal-x')?.addEventListener('click', () => close(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close(true);
  });
  for (const r of ranges) r.addEventListener('input', () => sync(r));

  document.getElementById('home-prefs-reset')?.addEventListener('click', () => {
    for (const r of ranges) {
      r.value = r.dataset.default || r.value;
      sync(r);
    }
  });

  document.getElementById('home-prefs-save')?.addEventListener('click', async () => {
    // Valor igual ao default é OMITIDO — o shape salvo só carrega o que difere
    // (mesma semântica do servidor: chave ausente = default).
    const heights: Record<string, number> = {};
    for (const r of ranges) {
      if (r.value !== r.dataset.default) heights[r.dataset.box || ''] = Number(r.value);
    }
    try {
      const res = await appFetch('/app/home/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ heights }),
      });
      if (!res.ok) throw new Error(`prefs ${res.status}`);
      toast('Caixas ajustadas.', 'ok');
      close(false);
    } catch (err) {
      console.warn('home: prefs save failed', err);
      toast('Não deu pra salvar as caixas. Tente de novo.');
    }
  });
}

wireToday();
wirePrefs();
