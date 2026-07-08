// Client da home /app (spec 50-console-v2/65 §2):
// - Quick-complete do card "Hoje" → POST /app/tasks/complete (mesmo endpoint do board).
// O feed "Atividade" (spec 69) é responsabilidade do journal.bundle.js, também
// incluído na home — o antigo card "Últimas interações" foi absorvido pelo feed.

import { appFetch } from './http.js';

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

wireToday();
