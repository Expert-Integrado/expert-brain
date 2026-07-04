import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { authorizeBearer } from './bearer-auth.js';
import {
  attachMedia, listMediaViews, removeMedia, fetchBlob, getMediaById, verifyMediaToken,
  MediaError, MAX_BYTES, type AttachInput,
} from '../media/store.js';
import { type MediaKind, MEDIA_KINDS } from '../db/media-queries.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Bearer (Console/cron/MCP-externo) OU sessão de browser. null = autorizado.
async function authReq(req: Request, env: Env): Promise<Response | null> {
  if (authorizeBearer(req, env)) return null;
  const s = await requireSession(req, env);
  return s.ok ? null : s.response;
}

function originOf(req: Request): string {
  return new URL(req.url).origin;
}

// POST /app/notes/{id}/media — JSON {base64|url, mime_type, kind, filename} OU multipart (file).
export async function handleMediaUpload(req: Request, env: Env, noteId: string): Promise<Response> {
  const denied = await authReq(req, env);
  if (denied) return denied;

  const ct = (req.headers.get('content-type') || '').toLowerCase();
  let input: AttachInput;
  try {
    if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      const entry = form.get('file');
      // Duck-type em vez de `instanceof File` (o lib do Worker não tipa File como
      // construtor utilizável aqui). Um File tem .arrayBuffer()/.size/.name/.type.
      if (!entry || typeof entry === 'string' || typeof (entry as any).arrayBuffer !== 'function') {
        return json({ error: 'multipart needs a "file" field' }, 400);
      }
      const file = entry as unknown as File;
      if (file.size > MAX_BYTES) return json({ error: `file is ${file.size} bytes — over the 50MB limit` }, 413);
      const kindRaw = String(form.get('kind') || '');
      input = {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime_type: file.type || String(form.get('mime_type') || '') || 'application/octet-stream',
        filename: file.name || (form.get('filename') as string) || undefined,
        kind: MEDIA_KINDS.includes(kindRaw as MediaKind) ? (kindRaw as MediaKind) : undefined,
      };
    } else {
      const body = await req.json() as any;
      input = {
        base64: body.base64, url: body.url, mime_type: body.mime_type,
        filename: body.filename, kind: body.kind,
      };
    }
  } catch {
    return json({ error: 'invalid request body' }, 400);
  }

  try {
    const r = await attachMedia(env, noteId, input, Date.now(), originOf(req));
    return json(r, 201);
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return json({ error: e instanceof Error ? e.message : 'upload failed' }, 500);
  }
}

// GET /app/notes/{id}/media — lista as mídias da nota (com signed URLs frescas).
export async function handleMediaList(req: Request, env: Env, noteId: string): Promise<Response> {
  const denied = await authReq(req, env);
  if (denied) return denied;
  const views = await listMediaViews(env, noteId, Date.now(), originOf(req));
  return json({ note_id: noteId, count: views.length, media: views });
}

// GET /app/media/{id} — serve o blob. Auth: signed token (?t=&sig=) OU sessão/bearer.
export async function handleMediaServe(req: Request, env: Env, mediaId: string): Promise<Response> {
  const url = new URL(req.url);
  const t = Number(url.searchParams.get('t') || '0');
  const sig = url.searchParams.get('sig') || '';
  let authed = false;
  if (sig && await verifyMediaToken(env, mediaId, t, sig, Date.now())) {
    authed = true;
  } else {
    authed = (await authReq(req, env)) === null;
  }
  if (!authed) return json({ error: 'unauthorized' }, 401);

  const media = await getMediaById(env, mediaId);
  if (!media) return json({ error: 'media not found' }, 404);
  const res = await fetchBlob(env, media);
  if (!res) return json({ error: 'blob missing in R2' }, 404);
  return res;
}

// DELETE /app/media/{id} — remove registro; blob R2 só se for a última referência.
export async function handleMediaDelete(req: Request, env: Env, mediaId: string): Promise<Response> {
  const denied = await authReq(req, env);
  if (denied) return denied;
  const r = await removeMedia(env, mediaId);
  if (!r) return json({ error: 'media not found' }, 404);
  return json({ ok: true, id: mediaId, blob_removed: r.removedBlob });
}
