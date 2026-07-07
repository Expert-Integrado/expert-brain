// Toast mínimo compartilhado pelos bundles do /app (spec 50-console-v2/72).
// Feedback visível pra ações client-side que antes falhavam só no console.
// Sem dependências: uma div fixa com aria-live, autodismiss, uma mensagem por vez.

let el: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, kind: 'error' | 'ok' = 'error'): void {
  if (!el || !el.isConnected) {
    el = document.createElement('div');
    el.className = 'app-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('is-visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el?.classList.remove('is-visible');
  }, 4000);
}
