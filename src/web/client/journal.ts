// Client do journal /app/journal (spec 50-console-v2/65 §3):
// - Filtros por tipo: checkboxes togglam uma classe no CONTAINER (não por item) —
//   itens anexados por "Carregar mais" já nascem filtrados sem JS por item novo.
// - "Carregar mais": intercepta o link (que sem JS navegaria/substituiria a página,
//   igual /app/notes) e faz fetch+append — o servidor devolve HTML pronto (mesmo
//   agrupamento por dia do SSR, via `carry` pro cabeçalho não repetir).

import { appFetch } from './http.js';

function wireFilters(): void {
  const container = document.getElementById('journal-groups');
  if (!container) return;
  document.querySelectorAll<HTMLInputElement>('.journal-filter').forEach((cb) => {
    cb.addEventListener('change', () => {
      container.classList.toggle(`journal-hide-${cb.value}`, !cb.checked);
    });
  });
}

interface JournalPageResponse { ok: boolean; html: string; next_url: string | null; last_label: string | null; }

async function loadMore(link: HTMLAnchorElement, container: HTMLElement): Promise<void> {
  const href = link.getAttribute('href');
  if (!href) return;
  const original = link.textContent;
  link.textContent = 'Carregando…';
  try {
    const res = await appFetch(href);
    if (!res.ok) throw new Error('journal load-more ' + res.status);
    const data: JournalPageResponse = await res.json();
    if (data.html) container.insertAdjacentHTML('beforeend', data.html);
    if (data.next_url) {
      const sep = data.next_url.includes('?') ? '&' : '?';
      link.setAttribute('href', `${data.next_url}${sep}carry=${encodeURIComponent(data.last_label ?? '')}`);
      link.textContent = original;
    } else {
      link.remove();
    }
  } catch (err) {
    link.textContent = original;
    console.warn('journal: load-more failed', err);
  }
}

function wireLoadMore(): void {
  const container = document.getElementById('journal-groups');
  const link = document.getElementById('journal-load-more') as HTMLAnchorElement | null;
  if (!link || !container) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    void loadMore(link, container);
  });
}

wireFilters();
wireLoadMore();
