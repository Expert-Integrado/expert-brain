// Client do feed de atividade (spec 50-console-v2/65 §3 + spec 69):
// - Roda na HOME (feed embutido, container data-lazy="1" — busca a 1ª página em
//   JSON de /app/journal e injeta) e na página standalone de paginação sem JS.
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

interface JournalPageResponse { ok: boolean; html: string; next_url: string | null; last_label: string | null; degraded?: boolean; }

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

// Home (spec 69): o feed nasce vazio (data-lazy="1") e a 1ª página vem em JSON —
// mesma resposta que o "Carregar mais" usa, então o append continua idêntico.
async function lazyLoadFirstPage(container: HTMLElement): Promise<void> {
  try {
    const res = await appFetch('/app/journal');
    if (!res.ok) throw new Error('journal first page ' + res.status);
    const data: JournalPageResponse = await res.json();
    container.innerHTML = data.html || '<p class="home-empty">Nada por aqui ainda — crie uma nota, uma task ou registre uma interação.</p>';
    if (data.degraded) {
      const p = document.createElement('p');
      p.className = 'journal-degraded';
      p.textContent = 'Interações de contato indisponíveis no momento — notas e tasks seguem normais.';
      container.parentElement?.insertBefore(p, container);
    }
    if (data.next_url) {
      const sep = data.next_url.includes('?') ? '&' : '?';
      const link = document.createElement('a');
      link.id = 'journal-load-more';
      link.className = 'notes-load-more';
      link.setAttribute('href', `${data.next_url}${sep}carry=${encodeURIComponent(data.last_label ?? '')}`);
      link.textContent = 'Carregar mais';
      container.insertAdjacentElement('afterend', link);
      wireLoadMore();
    }
  } catch (err) {
    container.innerHTML = '<p class="home-empty home-error">Não deu pra carregar a atividade agora. Recarregue a página.</p>';
    console.warn('journal: first page load failed', err);
  }
}

wireFilters();
const lazyContainer = document.getElementById('journal-groups');
if (lazyContainer && lazyContainer.dataset.lazy === '1') {
  void lazyLoadFirstPage(lazyContainer);
} else {
  wireLoadMore();
}
