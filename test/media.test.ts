import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { attachMedia, listMediaViews, removeMedia, getMediaById, verifyMediaToken, signedMediaPath } from '../src/media/store.js';

const E = env as any;

// 1x1 PNG transparente (base64).
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_OTHER = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function note(id: string) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,1,1,null)`
  ).bind(id, `Note ${id}`, 'b', 'tl', '["product"]', 'concept').run();
}

describe('note media', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM note_media');
    await E.DB.exec('DELETE FROM notes');
    // R2 não é isolado entre testes (isolatedStorage:false) — limpa os blobs pra
    // o estado de dedup não vazar de um teste pro outro.
    const objs = await E.MEDIA.list();
    for (const o of objs.objects ?? []) await E.MEDIA.delete(o.key);
    await note('n1');
    await note('n2');
  });

  it('attaches a base64 image, stores blob in R2, returns signed url', async () => {
    const r = await attachMedia(E, 'n1', { base64: PNG_1PX, mime_type: 'image/png', filename: 'a.png' }, 1000);
    expect(r.kind).toBe('image');
    expect(r.deduped).toBe(false);
    expect(r.r2_key).toMatch(/^sha256\/[0-9a-f]{64}\.png$/);
    expect(r.signed_url).toContain(`/app/media/${r.id}`);
    expect(r.signed_url).toContain('sig=');
    // blob really in R2
    const obj = await E.MEDIA.get(r.r2_key);
    expect(obj).not.toBeNull();
    // row in D1
    const row = await getMediaById(E, r.id);
    expect(row?.note_id).toBe('n1');
  });

  it('dedups identical bytes: same r2_key, 2 rows, second deduped', async () => {
    const a = await attachMedia(E, 'n1', { base64: PNG_1PX, mime_type: 'image/png' }, 1000);
    const b = await attachMedia(E, 'n2', { base64: PNG_1PX, mime_type: 'image/png' }, 1001);
    expect(b.r2_key).toBe(a.r2_key);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    const cnt = await E.DB.prepare(`SELECT count(*) c FROM note_media WHERE content_hash = ?`).bind(a.content_hash).first();
    expect(cnt.c).toBe(2);
  });

  it('rejects attach to a missing note', async () => {
    await expect(attachMedia(E, 'ghost', { base64: PNG_1PX, mime_type: 'image/png' }, 1000)).rejects.toThrow(/not found/);
  });

  it('lists media for a note', async () => {
    await attachMedia(E, 'n1', { base64: PNG_1PX, mime_type: 'image/png', filename: 'x.png' }, 1000);
    const views = await listMediaViews(E, 'n1', 2000);
    expect(views.length).toBe(1);
    expect(views[0].signed_url).toContain('/app/media/');
  });

  it('delete keeps blob while another ref exists, removes it on last ref (dedup-safe)', async () => {
    const a = await attachMedia(E, 'n1', { base64: PNG_1PX, mime_type: 'image/png' }, 1000);
    const b = await attachMedia(E, 'n2', { base64: PNG_1PX, mime_type: 'image/png' }, 1001);
    const r1 = await removeMedia(E, a.id);
    expect(r1?.removedBlob).toBe(false); // b still references the blob
    expect(await E.MEDIA.get(a.r2_key)).not.toBeNull();
    const r2 = await removeMedia(E, b.id);
    expect(r2?.removedBlob).toBe(true); // last ref gone
    expect(await E.MEDIA.get(a.r2_key)).toBeNull();
  });

  it('signed token validates and rejects tampering / expiry', async () => {
    const r = await attachMedia(E, 'n1', { base64: PNG_OTHER, mime_type: 'image/png' }, 1000);
    const url = new URL('http://x' + (await signedMediaPath(E, r.id, 5000)));
    const t = Number(url.searchParams.get('t'));
    const sig = url.searchParams.get('sig')!;
    expect(await verifyMediaToken(E, r.id, t, sig, 6000)).toBe(true);       // valid, not expired
    expect(await verifyMediaToken(E, r.id, t, sig, t + 1)).toBe(false);     // expired
    expect(await verifyMediaToken(E, r.id, t, 'deadbeef', 6000)).toBe(false); // tampered
  });
});

// spec 10-backend/23: o caminho URL do ingest nunca pode bufferizar acima de
// MAX_BYTES — content-length declarado grande rejeita sem ler; chunked/mentiroso
// aborta o stream com 413; chunked pequeno continua funcionando byte a byte.
describe('ingest by url with real byte cap (spec 23)', () => {

  function streamOf(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        onPull?.();
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    });
  }

  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM note_media');
    await E.DB.exec('DELETE FROM notes');
    await note('n1');
  });

  it('content-length declarado > 50MB rejeita 413 pelo header, sem bufferizar o corpo', async () => {
    // Nota: o runtime pode dar pull no stream ao construir a Response, então não dá
    // pra assertar "zero reads" aqui — o contrato testável é o 413 vindo do check de
    // header (mensagem "over the ... limit", não a de streaming abortado).
    vi.stubGlobal('fetch', async () => new Response(streamOf([new Uint8Array(8)]), {
      status: 200,
      headers: { 'content-length': String(51 * 1024 * 1024), 'content-type': 'image/png' },
    }));
    try {
      await expect(attachMedia(E, 'n1', { url: 'https://example.com/big.png' }, 1000)).rejects.toThrow(/over the/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('content-length ausente com corpo > 50MB aborta o stream com 413 (nunca bufferiza tudo)', async () => {
    // Reusa o MESMO buffer de 8MB em 7 chunks (56MB "lidos", ~8MB reais de RAM):
    // o contador do ingest aborta ao cruzar 50MB.
    const chunk = new Uint8Array(8 * 1024 * 1024);
    vi.stubGlobal('fetch', async () => new Response(streamOf(Array(7).fill(chunk)), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }));
    try {
      await expect(attachMedia(E, 'n1', { url: 'https://example.com/liar.bin' }, 1000)).rejects.toThrow(/exceeded.*while streaming/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('chunked pequeno sem content-length funciona com bytes identicos', async () => {
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
    vi.stubGlobal('fetch', async () => new Response(streamOf(parts), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }));
    try {
      const r = await attachMedia(E, 'n1', { url: 'https://example.com/small.bin' }, 1000);
      expect(r.size_bytes).toBe(6);
      const obj = await E.MEDIA.get(r.r2_key);
      const stored = new Uint8Array(await obj.arrayBuffer());
      expect([...stored]).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
