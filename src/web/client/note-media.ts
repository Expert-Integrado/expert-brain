// Client da seção de mídia na página da nota (/app/notes/:id) e da task
// (/app/tasks/:id) — ambas carregam este bundle. Lista as mídias (grid de
// thumbs), upload por drag-drop / file input (multipart), modal full-size com
// botão excluir. Também cuida do wiring dos botões "Copiar link" (detalhe de
// nota) e "✓ concluir" (detalhe de task): a CSP do app (script-src 'self',
// ver src/web/render.ts) bloqueia onclick inline, então o handler mora aqui.

import { appFetch } from './http.js';
import { confirmModal } from './confirm-modal.js';

interface MediaView {
  id: string; kind: string; mime_type: string; size_bytes: number;
  original_filename: string | null; created_at: number; signed_url: string;
}

const section = document.querySelector<HTMLElement>('.note-media');
const noteId = section?.dataset.noteId || '';
const grid = document.getElementById('media-grid');
const dropzone = document.getElementById('media-dropzone') as HTMLLabelElement | null;
const fileInput = document.getElementById('media-file-input') as HTMLInputElement | null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const DOC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const AUDIO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

function tileInner(m: MediaView): string {
  if (m.kind === 'image') return `<img src="${m.signed_url}" alt="${esc(m.original_filename || 'imagem')}" loading="lazy" />`;
  if (m.kind === 'video') return `<video src="${m.signed_url}" muted preload="metadata"></video>`;
  const icon = m.kind === 'audio' ? AUDIO_ICON : DOC_ICON;
  return `<div class="media-doc">${icon}<span>${esc(m.original_filename || m.kind)}</span></div>`;
}

let current: MediaView[] = [];

async function load() {
  if (!grid || !noteId) return;
  try {
    const res = await appFetch(`/app/notes/${encodeURIComponent(noteId)}/media`);
    if (!res.ok) throw new Error(`media list ${res.status}`);
    const data = await res.json();
    current = (data.media || []) as MediaView[];
    // Atalho da sidebar do detalhe de task (20/07): contagem acompanha a grade
    // (upload/remoção re-chamam load()). Página sem o atalho (nota) ignora.
    const attachLabel = document.querySelector<HTMLElement>('[data-attach-label]');
    if (attachLabel) {
      attachLabel.textContent = current.length > 0
        ? `${current.length} arquivo${current.length === 1 ? '' : 's'}`
        : 'Adicionar anexo';
    }
    grid.innerHTML = current.map((m) =>
      `<div class="media-tile" data-id="${esc(m.id)}" title="${esc(m.original_filename || m.kind)}">${tileInner(m)}</div>`
    ).join('');
    grid.querySelectorAll<HTMLElement>('.media-tile').forEach((tile) => {
      tile.addEventListener('click', () => openModal(tile.dataset.id || ''));
    });
  } catch (err) {
    // Falha silenciosa aqui fazia a nota parecer "sem anexos" — o dono re-subia
    // duplicado ou achava que perdeu arquivo. Erro tem que aparecer NO grid.
    console.warn('media: load failed', err);
    grid.innerHTML = '<p class="media-load-error">Não deu pra carregar os anexos — recarregue a página.</p>';
  }
}

function openModal(id: string) {
  const m = current.find((x) => x.id === id);
  if (!m) return;
  let full = '';
  if (m.kind === 'image') full = `<img src="${m.signed_url}" alt="${esc(m.original_filename || '')}" />`;
  else if (m.kind === 'video') full = `<video src="${m.signed_url}" controls autoplay></video>`;
  else if (m.kind === 'audio') full = `<audio src="${m.signed_url}" controls autoplay style="width:min(90vw,480px)"></audio>`;
  else full = `<div class="media-doc" style="color:#fff">${DOC_ICON}<div>${esc(m.original_filename || 'documento')}</div></div>`;

  const modal = document.createElement('div');
  modal.className = 'media-modal';
  modal.innerHTML = `${full}<div class="media-modal-bar">
    <a href="${m.signed_url}" target="_blank" rel="noopener">Abrir</a>
    <button class="media-del" type="button">Excluir</button>
    <button class="media-close" type="button">Fechar</button>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('.media-close')!.addEventListener('click', close);
  modal.querySelector('.media-del')!.addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Excluir esta mídia?', body: 'O arquivo sai do armazenamento — não dá pra desfazer.', verb: 'Excluir' }))) return;
    try {
      const res = await appFetch(`/app/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete ' + res.status);
    } catch (err) {
      console.warn('media: delete failed', err);
      alert('Não deu pra excluir a mídia — tente de novo.');
    }
    close();
    await load();
  });
}

async function uploadFiles(files: FileList | File[]) {
  if (!noteId || !dropzone) return;
  dropzone.classList.add('uploading');
  for (const file of Array.from(files)) {
    if (file.size > 50 * 1024 * 1024) { alert(`"${file.name}" passa de 50MB — pulado.`); continue; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await appFetch(`/app/notes/${encodeURIComponent(noteId)}/media`, {
        method: 'POST', body: fd,
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); console.warn('upload failed', res.status, e); alert(`Falha ao subir "${file.name}": ${(e as any).error || res.status}`); }
    } catch (err) {
      // Queda de rede no meio do upload era 100% muda — o arquivo simplesmente
      // não aparecia. Mesmo canal de aviso do erro HTTP logo acima.
      console.warn('media: upload error', err);
      alert(`Falha ao subir "${file.name}" — verifique a conexão e tente de novo.`);
    }
  }
  dropzone.classList.remove('uploading');
  await load();
}

if (fileInput) fileInput.addEventListener('change', () => { if (fileInput.files?.length) uploadFiles(fileInput.files); fileInput.value = ''; });
if (dropzone) {
  ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); }));
  ['dragleave', 'dragend'].forEach((ev) => dropzone.addEventListener(ev, () => dropzone.classList.remove('drag-over')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const files = (e as DragEvent).dataTransfer?.files;
    if (files?.length) uploadFiles(files);
  });
}

// Botão "Copiar link" (detalhe de nota). Reusa o mesmo fallback de
// document.execCommand('copy') que configPageScript() usa pra contexts sem
// navigator.clipboard (ver src/web/config.ts, copyText).
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* cai no fallback */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ok fica false */ }
  document.body.removeChild(ta);
  return ok;
}

const copyLinkBtn = document.getElementById('btn-copy-link');
if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async () => {
    const ok = await copyText(location.href);
    const original = copyLinkBtn.textContent;
    copyLinkBtn.textContent = ok ? 'Link copiado!' : 'Selecione + Ctrl+C';
    setTimeout(() => { copyLinkBtn.textContent = original; }, 2000);
  });
}

// Botão "✓ concluir" (detalhe de task). POSTa /app/tasks/complete e navega
// pro board em sucesso; reabilita + alerta em falha.
const completeBtn = document.querySelector<HTMLButtonElement>('[data-task-complete]');
if (completeBtn) {
  completeBtn.addEventListener('click', async () => {
    const taskId = completeBtn.dataset.taskId;
    if (!taskId) return;
    completeBtn.disabled = true;
    completeBtn.textContent = 'concluindo...';
    try {
      const res = await appFetch('/app/tasks/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: taskId }),
      });
      if (!res.ok) throw new Error('complete ' + res.status);
      location.href = '/app/tasks';
    } catch (err) {
      console.warn('task complete failed', err);
      completeBtn.disabled = false;
      completeBtn.textContent = '✓ concluir';
      alert('Falha ao concluir');
    }
  });
}

load();

export {};
