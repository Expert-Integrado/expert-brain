import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { createApiKey, revokeApiKey } from '../src/auth/api-keys.js';
import { handleMediaUpload, handleMediaList, handleMediaServe, handleMediaDelete } from '../src/web/media.js';
import { attachMedia } from '../src/media/store.js';

const E = env as any;

// spec 10-backend/25: upload direto com PAT — o agente manda os BYTES via multipart
// (curl -F), nunca base64 gerado como texto pelo modelo. Estes testes cobrem a matriz
// de auth da superfície de mídia: PAT full/read/revogado, escopo private e sessão.

// Payload binário proposital (não-UTF8, não-ASCII): o coração da spec é fidelidade
// de bytes — o teste compara sha256 local com o content_hash devolvido e o blob no R2.
function binaryPayload(): Uint8Array {
  const b = new Uint8Array(4096);
  for (let i = 0; i < b.length; i++) b[i] = (i * 7 + 13) % 256;
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // magic PNG
  return b;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function note(id: string, priv = 0): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,1,1,null)`
  ).bind(id, `Note ${id}`, 'b', 'tl', '["product"]', 'concept', priv).run();
}

async function ownerCookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function pat(scopes: string): Promise<string> {
  const r = await createApiKey(E, E.OWNER_EMAIL, `test-${scopes}`, scopes);
  return r.plainKey;
}

interface ReqOpts { bearer?: string; cookie?: string }

function uploadReq(noteId: string, bytes: Uint8Array, opts: ReqOpts = {}): Request {
  const fd = new FormData();
  fd.append('file', new File([bytes.buffer as ArrayBuffer], 'direto.png', { type: 'image/png' }));
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`https://x/app/notes/${noteId}/media`, { method: 'POST', headers, body: fd });
}

function plainReq(method: string, path: string, opts: ReqOpts = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`https://x${path}`, { method, headers });
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM note_media');
  await E.DB.exec('DELETE FROM api_keys');
  await E.DB.exec('DELETE FROM notes');
  const objs = await E.MEDIA.list();
  for (const o of objs.objects ?? []) await E.MEDIA.delete(o.key);
  await note('pub');
  await note('priv', 1);
});

describe('upload multipart com PAT (spec 25)', () => {
  it('PAT full: 201 com fidelidade de bytes (sha256 local == content_hash, blob idêntico no R2)', async () => {
    const bytes = binaryPayload();
    const res = await handleMediaUpload(uploadReq('pub', bytes, { bearer: await pat('full') }), E, 'pub');
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.content_hash).toBe(await sha256Hex(bytes));
    const obj = await E.MEDIA.get(body.r2_key);
    const stored = new Uint8Array(await obj.arrayBuffer());
    expect(stored.length).toBe(bytes.length);
    expect(Buffer.from(stored).equals(Buffer.from(bytes))).toBe(true);
  });

  it('PAT read: POST 403 e nada gravado', async () => {
    const res = await handleMediaUpload(uploadReq('pub', binaryPayload(), { bearer: await pat('read') }), E, 'pub');
    expect(res.status).toBe(403);
    const cnt = await E.DB.prepare(`SELECT count(*) c FROM note_media`).first();
    expect(cnt.c).toBe(0);
  });

  it('eb_pat_ inválido: 401 JSON direto, sem redirect de login', async () => {
    const res = await handleMediaUpload(uploadReq('pub', binaryPayload(), { bearer: 'eb_pat_fake_key' }), E, 'pub');
    expect(res.status).toBe(401);
    expect((res.headers.get('content-type') || '')).toContain('application/json');
  });

  it('PAT revogado: 401', async () => {
    const r = await createApiKey(E, E.OWNER_EMAIL, 'revogada', 'full');
    await revokeApiKey(E, E.OWNER_EMAIL, r.row.id);
    const res = await handleMediaUpload(uploadReq('pub', binaryPayload(), { bearer: r.plainKey }), E, 'pub');
    expect(res.status).toBe(401);
  });

  it('sem auth nenhum: comportamento atual preservado (401 JSON de sessão, rota de dados)', async () => {
    const res = await handleMediaUpload(uploadReq('pub', binaryPayload()), E, 'pub');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session expired' });
  });
});

describe('nota privada (escopo private, fail-closed)', () => {
  it('PAT full SEM private: 404 (nota não vaza existência)', async () => {
    const res = await handleMediaUpload(uploadReq('priv', binaryPayload(), { bearer: await pat('full') }), E, 'priv');
    expect(res.status).toBe(404);
  });

  it('PAT full,private: 201', async () => {
    const res = await handleMediaUpload(uploadReq('priv', binaryPayload(), { bearer: await pat('full,private') }), E, 'priv');
    expect(res.status).toBe(201);
  });

  it('sessão do dono: 201 (bug pré-existente do console corrigido)', async () => {
    const res = await handleMediaUpload(uploadReq('priv', binaryPayload(), { cookie: await ownerCookie() }), E, 'priv');
    expect(res.status).toBe(201);
  });

  it('listar/servir mídia de nota privada via PAT sem escopo: 404; com escopo: 200', async () => {
    const a = await attachMedia(E, 'priv', { bytes: binaryPayload(), mime_type: 'image/png' }, 1000, undefined, true);
    const noScope = await pat('full');
    const withScope = await pat('full,private');
    expect((await handleMediaList(plainReq('GET', '/app/notes/priv/media', { bearer: noScope }), E, 'priv')).status).toBe(404);
    expect((await handleMediaList(plainReq('GET', '/app/notes/priv/media', { bearer: withScope }), E, 'priv')).status).toBe(200);
    expect((await handleMediaServe(plainReq('GET', `/app/media/${a.id}`, { bearer: noScope }), E, a.id)).status).toBe(404);
    expect((await handleMediaServe(plainReq('GET', `/app/media/${a.id}`, { bearer: withScope }), E, a.id)).status).toBe(200);
  });
});

describe('listar / servir / deletar com PAT', () => {
  it('PAT read lista e serve mídia de nota pública', async () => {
    const a = await attachMedia(E, 'pub', { bytes: binaryPayload(), mime_type: 'image/png' }, 1000);
    const key = await pat('read');
    const list = await handleMediaList(plainReq('GET', '/app/notes/pub/media', { bearer: key }), E, 'pub');
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).count).toBe(1);
    const serve = await handleMediaServe(plainReq('GET', `/app/media/${a.id}`, { bearer: key }), E, a.id);
    expect(serve.status).toBe(200);
  });

  it('DELETE: PAT read 403; PAT full 200', async () => {
    const a = await attachMedia(E, 'pub', { bytes: binaryPayload(), mime_type: 'image/png' }, 1000);
    expect((await handleMediaDelete(plainReq('DELETE', `/app/media/${a.id}`, { bearer: await pat('read') }), E, a.id)).status).toBe(403);
    expect((await handleMediaDelete(plainReq('DELETE', `/app/media/${a.id}`, { bearer: await pat('full') }), E, a.id)).status).toBe(200);
  });

  it('DELETE de mídia de nota privada: PAT full sem escopo 404', async () => {
    const a = await attachMedia(E, 'priv', { bytes: binaryPayload(), mime_type: 'image/png' }, 1000, undefined, true);
    expect((await handleMediaDelete(plainReq('DELETE', `/app/media/${a.id}`, { bearer: await pat('full') }), E, a.id)).status).toBe(404);
  });
});
