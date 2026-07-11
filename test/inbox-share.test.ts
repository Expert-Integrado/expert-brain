import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import {
  handleInboxPage,
  handleInboxSharePost,
  handleInboxShareUploadPost,
  handleInboxMediaServe,
  handleInboxToNotePost,
  handleInboxResolvePost,
} from '../src/web/inbox.js';
import { getInboxItem, countPendingInbox } from '../src/db/queries.js';
import { listInboxMediaByItem } from '../src/db/media-queries.js';

// Web Share Target nível 2 (specs/50-console-v2/68): arquivo compartilhado pelo
// share sheet vira item do inbox COM anexo. Dados 100% fictícios (repo público).

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function pngBytes(): Uint8Array {
  const b = new Uint8Array(2048);
  for (let i = 0; i < b.length; i++) b[i] = (i * 11 + 5) % 256;
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
}

function shareReq(opts: { cookie?: string; fields?: Record<string, string>; file?: { name: string; type: string; bytes: Uint8Array } } = {}): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) fd.set(k, v);
  if (opts.file) {
    fd.set('media', new File([opts.file.bytes.buffer as ArrayBuffer], opts.file.name, { type: opts.file.type }));
  }
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request('https://x/app/inbox/share', { method: 'POST', headers, body: fd });
}

async function resetDb(): Promise<void> {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM inbox_media');
  await E.DB.exec('DELETE FROM inbox_items');
  await E.DB.exec('DELETE FROM note_media');
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM similar_edges');
  await E.DB.exec('DELETE FROM notes');
}

describe('POST /app/inbox/share (fallback do share target, sem SW)', () => {
  beforeEach(resetDb);

  it('sem sessão: degrada pro fluxo GET (303 com texto nos params, arquivo se perde, nada gravado)', async () => {
    const res = await handleInboxSharePost(
      shareReq({ fields: { title: 'Ideia', text: 'conteudo compartilhado' }, file: { name: 'foto.png', type: 'image/png', bytes: pngBytes() } }),
      E
    );
    expect(res.status).toBe(303);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/app/inbox?');
    expect(loc).toContain('title=Ideia');
    expect(loc).toContain('text=conteudo');
    expect(loc).not.toContain('share=file');
    expect(await countPendingInbox(E)).toBe(0);
  });

  it('com sessão + arquivo: cria o item completo (source pwa-share + anexo) e volta pro inbox', async () => {
    const res = await handleInboxSharePost(
      shareReq({ cookie: await cookie(), fields: { text: 'print do dashboard' }, file: { name: 'print.png', type: 'image/png', bytes: pngBytes() } }),
      E
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/inbox');
    const row = await E.DB.prepare('SELECT id, body, source FROM inbox_items').first();
    expect(row.body).toBe('print do dashboard');
    expect(row.source).toBe('pwa-share');
    const media = await listInboxMediaByItem(E, row.id);
    expect(media).toHaveLength(1);
    expect(media[0].kind).toBe('image');
    expect(media[0].mime_type).toBe('image/png');
    expect(media[0].original_filename).toBe('print.png');
    // blob no R2 com a key canônica sha256/<hash>.png
    expect(media[0].r2_key).toMatch(/^sha256\/[0-9a-f]{64}\.png$/);
    const blob = await E.MEDIA.get(media[0].r2_key);
    expect(blob).not.toBeNull();
  });
});

describe('POST /app/inbox/share-upload (segunda perna do SW handoff)', () => {
  beforeEach(resetDb);

  it('sem sessão: 401 JSON, nada gravado', async () => {
    const fd = new FormData();
    fd.set('text', 'x');
    const res = await handleInboxShareUploadPost(new Request('https://x/app/inbox/share-upload', { method: 'POST', body: fd }), E);
    expect(res.status).toBe(401);
    expect(await countPendingInbox(E)).toBe(0);
  });

  it('texto + arquivo: 201 com id, item + anexo gravados', async () => {
    const fd = new FormData();
    fd.set('text', 'Ideia\n\nhttps://exemplo.com');
    fd.set('media', new File([pngBytes().buffer as ArrayBuffer], 'grafico.png', { type: 'image/png' }));
    const res = await handleInboxShareUploadPost(
      new Request('https://x/app/inbox/share-upload', { method: 'POST', headers: { cookie: await cookie() }, body: fd }),
      E
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { ok: boolean; id: string };
    expect(data.ok).toBe(true);
    const item = await getInboxItem(E, data.id);
    expect(item?.body).toContain('Ideia');
    expect(item?.source).toBe('pwa-share');
    expect(await listInboxMediaByItem(E, data.id)).toHaveLength(1);
  });

  it('arquivo sem texto: body vira placeholder com o nome do arquivo', async () => {
    const fd = new FormData();
    fd.set('media', new File([pngBytes().buffer as ArrayBuffer], 'captura.png', { type: 'image/png' }));
    const res = await handleInboxShareUploadPost(
      new Request('https://x/app/inbox/share-upload', { method: 'POST', headers: { cookie: await cookie() }, body: fd }),
      E
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string };
    const item = await getInboxItem(E, data.id);
    expect(item?.body).toContain('captura.png');
  });

  it('sem texto e sem arquivo: 400', async () => {
    const fd = new FormData();
    const res = await handleInboxShareUploadPost(
      new Request('https://x/app/inbox/share-upload', { method: 'POST', headers: { cookie: await cookie() }, body: fd }),
      E
    );
    expect(res.status).toBe(400);
  });
});

describe('anexo do inbox: serve, render, triagem e descarte', () => {
  beforeEach(resetDb);

  async function sharedItem(): Promise<{ itemId: string; mediaId: string; r2Key: string }> {
    const fd = new FormData();
    fd.set('text', 'item com anexo');
    fd.set('media', new File([pngBytes().buffer as ArrayBuffer], 'anexo.png', { type: 'image/png' }));
    const res = await handleInboxShareUploadPost(
      new Request('https://x/app/inbox/share-upload', { method: 'POST', headers: { cookie: await cookie() }, body: fd }),
      E
    );
    const { id } = (await res.json()) as { id: string };
    const [m] = await listInboxMediaByItem(E, id);
    return { itemId: id, mediaId: m.id, r2Key: m.r2_key };
  }

  it('GET /app/inbox/media/:id com sessão serve o blob; sem sessão redireciona pro login', async () => {
    const { mediaId } = await sharedItem();
    const ok = await handleInboxMediaServe(new Request('https://x/app/inbox/media/' + mediaId, { headers: { cookie: await cookie() } }), E, mediaId);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await ok.arrayBuffer());
    expect(bytes.length).toBe(2048);
    const anon = await handleInboxMediaServe(new Request('https://x/app/inbox/media/' + mediaId), E, mediaId);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toContain('/app/login');
  });

  it('filename com emoji/CJK não derruba o serve (content-disposition é ByteString Latin-1)', async () => {
    const fd = new FormData();
    fd.set('media', new File([pngBytes().buffer as ArrayBuffer], 'captura 📷 中文.png', { type: 'image/png' }));
    const up = await handleInboxShareUploadPost(
      new Request('https://x/app/inbox/share-upload', { method: 'POST', headers: { cookie: await cookie() }, body: fd }),
      E
    );
    const { id } = (await up.json()) as { id: string };
    const [m] = await listInboxMediaByItem(E, id);
    const res = await handleInboxMediaServe(new Request('https://x/app/inbox/media/' + m.id, { headers: { cookie: await cookie() } }), E, m.id);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    // caracteres fora do Latin-1 viram '_' — o header nunca lança TypeError
    expect(cd).not.toMatch(/[Ā-￿]/);
  });

  it('a página do inbox renderiza o thumbnail do anexo', async () => {
    const { mediaId } = await sharedItem();
    const res = await handleInboxPage(new Request('https://x/app/inbox', { headers: { cookie: await cookie() } }), E);
    const html = await res.text();
    expect(html).toContain(`/app/inbox/media/${mediaId}`);
    expect(html).toContain('inbox-item-img');
  });

  it('virar nota migra o anexo pra note_media (mesma key R2) e limpa inbox_media', async () => {
    E.AI = { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
    E.VECTORIZE = { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) };
    const { itemId, r2Key } = await sharedItem();
    const form = new URLSearchParams({ id: itemId }).toString();
    const res = await handleInboxToNotePost(
      new Request('https://x/app/inbox/to-note', {
        method: 'POST',
        headers: { cookie: await cookie(), 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      E
    );
    expect(res.status).toBe(302);
    const noteId = res.headers.get('location')!.split('/').pop()!.split('?')[0];
    const noteMedia = await E.DB.prepare('SELECT r2_key, kind FROM note_media WHERE note_id = ?').bind(noteId).first();
    expect(noteMedia.r2_key).toBe(r2Key);
    expect(noteMedia.kind).toBe('image');
    expect(await listInboxMediaByItem(E, itemId)).toHaveLength(0);
    // blob continua no R2 (agora referenciado pela nota)
    expect(await E.MEDIA.get(r2Key)).not.toBeNull();
  });

  it('descartar remove o anexo e o blob R2 quando era a última referência', async () => {
    const { itemId, r2Key } = await sharedItem();
    const form = new URLSearchParams({ id: itemId, action: 'discard' }).toString();
    const res = await handleInboxResolvePost(
      new Request('https://x/app/inbox/resolve', {
        method: 'POST',
        headers: { cookie: await cookie(), 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      E
    );
    expect(res.status).toBe(302);
    expect(await listInboxMediaByItem(E, itemId)).toHaveLength(0);
    expect(await E.MEDIA.get(r2Key)).toBeNull();
  });
});
