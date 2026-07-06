// Client da home /app (spec 50-console-v2/65 §2):
// - Quick-complete do card "Hoje" → POST /app/tasks/complete (mesmo endpoint do board).
// - Card "Últimas interações" carrega ASSÍNCRONO (GET /app/contacts/events/recent) —
//   nunca bloqueia o SSR da home no proxy pro Worker do Contacts.

import { appFetch } from './http.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

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

// ts vem do contacts como "YYYY-MM-DD HH:MM:SS" (UTC, datetime('now') do SQLite).
function formatEventWhen(ts: string): string {
  const ms = Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) return ts;
  return new Date(ms).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

interface RecentEvent { id: string; entity_id: string; entity_name: string; kind: string; ts: string; context: string | null; }

async function loadInteractions(): Promise<void> {
  const el = document.getElementById('home-events-list');
  if (!el) return;
  const limit = el.dataset.limit || '5';
  try {
    const res = await appFetch(`/app/contacts/events/recent?limit=${encodeURIComponent(limit)}`);
    if (!res.ok) throw new Error('events ' + res.status);
    const data: { events?: RecentEvent[] } = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    if (events.length === 0) {
      el.innerHTML = '<li class="home-empty">Nenhuma interação registrada ainda.</li>';
      return;
    }
    el.innerHTML = events
      .map((ev) => {
        const url = `/app/contacts/${encodeURIComponent(ev.entity_id)}`;
        return `<li>
          <a class="home-event-title" href="${url}">${esc(ev.entity_name || 'Contato')}</a>
          <span class="home-event-kind">${esc(ev.kind)}</span>
          <span class="home-event-when">${esc(formatEventWhen(ev.ts))}</span>
        </li>`;
      })
      .join('');
  } catch (err) {
    el.innerHTML = '<li class="home-empty home-error">Não foi possível carregar as interações agora.</li>';
    console.warn('home: interactions load failed', err);
  }
}

wireToday();
void loadInteractions();
