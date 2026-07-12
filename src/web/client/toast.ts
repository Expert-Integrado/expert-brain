// Toast mínimo compartilhado pelos bundles do /app (spec 50-console-v2/72).
// Feedback visível pra ações client-side que antes falhavam só no console.
// Sem dependências: uma div fixa com aria-live, autodismiss, uma mensagem por vez.
// Spec 91-experiencia-premium/95: opcionalmente carrega UM botão de ação
// ("Desfazer") — com ação o autodismiss estica pra 8s, tempo de reagir.

let el: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export interface ToastOpts {
  action?: { label: string; onClick: () => void };
  duration?: number;
}

export function toast(msg: string, kind: 'error' | 'ok' = 'error', opts: ToastOpts = {}): void {
  if (!el || !el.isConnected) {
    el = document.createElement('div');
    el.className = 'app-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.dataset.kind = kind;
  if (opts.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-toast-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => {
      el?.classList.remove('is-visible');
      clearTimeout(hideTimer);
      opts.action!.onClick();
    });
    el.appendChild(btn);
  }
  el.classList.add('is-visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el?.classList.remove('is-visible');
  }, opts.duration ?? (opts.action ? 8000 : 4000));
}
