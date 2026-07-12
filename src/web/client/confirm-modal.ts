// Confirmação com marca no lugar do window.confirm nativo (spec 91-experiencia-
// premium/95). Mesmo contrato de decisão do confirm (Promise<boolean>), mas com
// o modal genérico do design system (.modal/.modal-dialog) — o nativo trava a
// thread, não tem estilo e grita "web 1.0" num produto premium.
//
// Uso: `if (!(await confirmModal({ title, body, verb }))) return;`
// Foco vai pro botão de confirmar; Esc/backdrop/Cancelar resolvem false.
// Reservado pra ação IRREVERSÍVEL (revogar link, apagar mídia/tag) — destrutivo
// reversível usa o toast "Desfazer" (wireUndoToast), não confirmação.

export interface ConfirmOpts {
  title: string;
  body?: string;
  verb?: string;      // rótulo do botão de confirmar (default "Confirmar")
  danger?: boolean;   // true = botão vermelho (.btn-danger)
}

let openModal: HTMLDivElement | null = null;

export function confirmModal(opts: ConfirmOpts): Promise<boolean> {
  // Uma confirmação por vez — abrir outra resolve a anterior como cancelada.
  if (openModal) { openModal.remove(); openModal = null; }

  return new Promise<boolean>((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal confirm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog confirm-dialog';

    const head = document.createElement('div');
    head.className = 'modal-head';
    const h = document.createElement('strong');
    h.textContent = opts.title;
    head.appendChild(h);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    if (opts.body) {
      const p = document.createElement('p');
      p.className = 'confirm-body-text';
      p.textContent = opts.body;
      bodyEl.appendChild(p);
    }

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancelar';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = opts.danger === false ? 'btn btn-primary' : 'btn btn-danger';
    okBtn.textContent = opts.verb ?? 'Confirmar';
    actions.append(cancelBtn, okBtn);
    bodyEl.appendChild(actions);

    dialog.append(head, bodyEl);
    modal.append(backdrop, dialog);
    document.body.appendChild(modal);
    openModal = modal;

    const prevFocus = document.activeElement as HTMLElement | null;
    const done = (result: boolean) => {
      modal.remove();
      if (openModal === modal) openModal = null;
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter' && document.activeElement === okBtn) { e.preventDefault(); done(true); }
    };

    backdrop.addEventListener('click', () => done(false));
    cancelBtn.addEventListener('click', () => done(false));
    okBtn.addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey, true);
    okBtn.focus();
  });
}
