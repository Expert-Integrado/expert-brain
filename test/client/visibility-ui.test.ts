// Testes do seletor único de visibilidade (src/web/client/visibility-ui.ts,
// specs/60-ux-reforma/65) em jsdom. Cobre a state machine de transições:
// Privado / Normal / Link público, com os POSTs certos (private/share/unshare),
// confirmação nas destrutivas (confirmModal desde a spec 95, mockado aqui) e
// fail-safe pro estado menos exposto.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initVisibilityUi } from '../../src/web/client/visibility-ui.js';
import { appFetch } from '../../src/web/client/http.js';
import { confirmModal } from '../../src/web/client/confirm-modal.js';

vi.mock('../../src/web/client/http.js', () => ({
  appFetch: vi.fn(),
}));
vi.mock('../../src/web/client/confirm-modal.js', () => ({
  confirmModal: vi.fn(async () => true),
}));

const appFetchMock = vi.mocked(appFetch);
const confirmModalMock = vi.mocked(confirmModal);

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

type VisState = 'private' | 'normal' | 'link';

function mount(state: VisState, opts: { shared?: boolean; kind?: 'task' | 'note' } = {}): HTMLElement {
  const kind = opts.kind ?? 'task';
  const privateAction = kind === 'task' ? '/app/tasks/private' : '/app/notes/t1/private';
  const endpoint = kind === 'task' ? '/app/tasks' : '/app/notes';
  document.body.innerHTML = `
    <section class="task-visibility" data-visibility data-kind="${kind}" data-id="t1"
      data-share-endpoint="${endpoint}" data-private-action="${privateAction}"
      data-state="${state}" data-shared="${opts.shared ? '1' : '0'}">
      <div class="vis-group" role="radiogroup">
        <label class="vis-opt${state === 'private' ? ' selected' : ''}"><input type="radio" name="visibility" value="private"${state === 'private' ? ' checked' : ''} /></label>
        <label class="vis-opt${state === 'normal' ? ' selected' : ''}"><input type="radio" name="visibility" value="normal"${state === 'normal' ? ' checked' : ''} /></label>
        <label class="vis-opt${state === 'link' ? ' selected' : ''}"><input type="radio" name="visibility" value="link"${state === 'link' ? ' checked' : ''} /></label>
      </div>
      <div class="vis-panel" data-vis-panel${state === 'link' ? '' : ' hidden'}>
        <p data-share-state></p>
        <input type="number" min="1" max="365" value="30" data-share-days />
        <button type="button" data-share-generate>Gerar link</button>
        <button type="button" data-share-revoke${opts.shared ? '' : ' hidden'}>Revogar</button>
        <div data-share-link hidden><input type="text" readonly data-share-url /><button type="button" data-share-copy>Copiar</button></div>
      </div>
      <div data-share-status role="status"></div>
    </section>`;
  initVisibilityUi();
  return document.querySelector<HTMLElement>('[data-visibility]')!;
}

function pick(value: VisState): void {
  const radio = document.querySelector<HTMLInputElement>(`input[name="visibility"][value="${value}"]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

function checkedValue(): string | undefined {
  return document.querySelector<HTMLInputElement>('input[name="visibility"]:checked')?.value;
}

beforeEach(() => {
  appFetchMock.mockReset();
  confirmModalMock.mockReset();
  confirmModalMock.mockResolvedValue(true);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('initVisibilityUi — transições', () => {
  it('normal → privado: POST private=true, sem confirmação', async () => {
    appFetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    const root = mount('normal');
    pick('private');
    await vi.waitFor(() => expect(root.dataset.state).toBe('private'));
    expect(confirmModalMock).not.toHaveBeenCalled();
    expect(appFetchMock).toHaveBeenCalledExactlyOnceWith('/app/tasks/private', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 't1', private: true }),
    });
    expect(root.querySelector<HTMLElement>('[data-vis-panel]')!.hidden).toBe(true);
  });

  it('privado → normal: POST private=false', async () => {
    appFetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    const root = mount('private');
    pick('normal');
    await vi.waitFor(() => expect(root.dataset.state).toBe('normal'));
    expect(appFetchMock).toHaveBeenCalledExactlyOnceWith('/app/tasks/private', expect.objectContaining({
      body: JSON.stringify({ id: 't1', private: false }),
    }));
  });

  it('POST falhou → radio volta pro estado real', async () => {
    appFetchMock.mockResolvedValueOnce(jsonRes({ error: 'boom' }, false, 500));
    const root = mount('normal');
    pick('private');
    await vi.waitFor(() => expect(checkedValue()).toBe('normal'));
    expect(root.dataset.state).toBe('normal');
    expect(document.querySelector('[data-share-status]')!.textContent).toContain('boom');
  });

  it('link → normal: confirma e revoga; recusar não faz POST nenhum', async () => {
    // recusa
    confirmModalMock.mockResolvedValue(false);
    let root = mount('link', { shared: true });
    pick('normal');
    await vi.waitFor(() => expect(checkedValue()).toBe('link'));
    expect(appFetchMock).not.toHaveBeenCalled();
    expect(root.dataset.state).toBe('link');

    // aceita
    confirmModalMock.mockResolvedValue(true);
    appFetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    root = mount('link', { shared: true });
    pick('normal');
    await vi.waitFor(() => expect(root.dataset.state).toBe('normal'));
    expect(appFetchMock).toHaveBeenCalledExactlyOnceWith('/app/tasks/unshare', expect.objectContaining({
      body: JSON.stringify({ id: 't1' }),
    }));
    expect(root.dataset.shared).toBe('0');
    expect(root.querySelector<HTMLElement>('[data-vis-panel]')!.hidden).toBe(true);
  });

  it('link → privado: confirma; private=true no server já revoga o link junto', async () => {
    appFetchMock.mockResolvedValueOnce(jsonRes({ ok: true, share_revoked: true }));
    const root = mount('link', { shared: true });
    pick('private');
    await vi.waitFor(() => expect(root.dataset.state).toBe('private'));
    expect(appFetchMock).toHaveBeenCalledExactlyOnceWith('/app/tasks/private', expect.objectContaining({
      body: JSON.stringify({ id: 't1', private: true }),
    }));
    expect(root.dataset.shared).toBe('0');
    expect(root.querySelector<HTMLButtonElement>('[data-share-revoke]')!.hidden).toBe(true);
  });

  it('normal → link: só abre o painel (nenhum POST até clicar em Gerar link)', async () => {
    const root = mount('normal');
    pick('link');
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-vis-panel]')!.hidden).toBe(false));
    expect(appFetchMock).not.toHaveBeenCalled();
    expect(root.dataset.state).toBe('normal'); // estado real só muda quando o link nasce

    appFetchMock.mockResolvedValueOnce(jsonRes({ url: 'https://x.dev/s/ebs_abc', expires_brt: '08/08/2026 12:00' }));
    root.querySelector<HTMLButtonElement>('[data-share-generate]')!.click();
    await vi.waitFor(() => expect(root.dataset.state).toBe('link'));
    expect(appFetchMock).toHaveBeenCalledExactlyOnceWith('/app/tasks/share', expect.objectContaining({
      body: JSON.stringify({ id: 't1', expires_days: 30, renew: false, include_media: false }),
    }));
    expect(root.dataset.shared).toBe('1');
    expect(root.querySelector<HTMLInputElement>('[data-share-url]')!.value).toBe('https://x.dev/s/ebs_abc');
    expect(root.querySelector<HTMLElement>('[data-share-link]')!.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-share-revoke]')!.hidden).toBe(false);
  });

  it('privado → link: confirma, despriva e já gera o link (2 POSTs encadeados)', async () => {
    appFetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true })) // private=false
      .mockResolvedValueOnce(jsonRes({ url: 'https://x.dev/s/ebs_novo', expires_brt: '08/08/2026 12:00' })); // share
    const root = mount('private');
    pick('link');
    await vi.waitFor(() => expect(root.dataset.state).toBe('link'));
    expect(appFetchMock).toHaveBeenNthCalledWith(1, '/app/tasks/private', expect.objectContaining({
      body: JSON.stringify({ id: 't1', private: false }),
    }));
    expect(appFetchMock).toHaveBeenNthCalledWith(2, '/app/tasks/share', expect.anything());
    expect(root.dataset.shared).toBe('1');
  });

  it('privado → link com geração falhando: para em NORMAL (fail-safe menos exposto)', async () => {
    appFetchMock
      .mockResolvedValueOnce(jsonRes({ ok: true })) // private=false ok
      .mockResolvedValueOnce(jsonRes({ error: 'share quebrou' }, false, 500)); // share falha
    const root = mount('private');
    pick('link');
    await vi.waitFor(() => expect(checkedValue()).toBe('normal'));
    expect(root.dataset.state).toBe('normal');
    expect(root.dataset.shared).toBe('0');
  });

  it('botão Revogar: confirma, POST unshare e cai pra normal', async () => {
    appFetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    const root = mount('link', { shared: true });
    root.querySelector<HTMLButtonElement>('[data-share-revoke]')!.click();
    await vi.waitFor(() => expect(root.dataset.state).toBe('normal'));
    expect(appFetchMock).toHaveBeenCalledExactlyOnceWith('/app/tasks/unshare', expect.anything());
    expect(checkedValue()).toBe('normal');
  });

  it('nota usa o endpoint próprio de private (path com id)', async () => {
    appFetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    const root = mount('normal', { kind: 'note' });
    pick('private');
    await vi.waitFor(() => expect(root.dataset.state).toBe('private'));
    expect(appFetchMock).toHaveBeenCalledExactlyOnceWith('/app/notes/t1/private', expect.anything());
  });
});
