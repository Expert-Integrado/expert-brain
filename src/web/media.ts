import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { authorizeBearer } from './bearer-auth.js';
import { validateApiKey, hasScope } from '../auth/api-keys.js';
import { scopesSeePrivate } from '../auth/visibility.js';
import { getNoteById } from '../db/queries.js';
import {
  attachMedia, listMediaViews, removeMedia, fetchBlob, getMediaById, verifyMediaToken,
  MediaError, MAX_BYTES, type AttachInput,
} from '../media/store.js';
import { type MediaKind, MEDIA_KINDS } from '../db/media-queries.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Resultado da auth: 'owner' = sessão de browser ou GRAPH_EXPORT_TOKEN (nível dono,
// comportamento histórico intacto); 'pat' carrega os escopos pro gate de privacidade.
type MediaAuth = { level: 'owner' } | { level: 'pat'; scopes: string };

// Auth da superfície de mídia. Além de sessão/GRAPH_EXPORT (o TASK_REMINDER_TOKEN do
// cron NÃO autoriza mídia, spec 17), aceita PAT eb_pat_* (spec 10-backend/25) — é o
// canal de upload DIRETO dos agentes (curl -F com o mesmo Bearer do MCP), que elimina
// base64 gerado como texto pelo modelo (perda silenciosa de bytes em payload grande).
// PAT read-only não muta (403); eb_pat_ inválido = 401 JSON, sem redirect de login.
async function authReq(req: Request, env: Env, write = false): Promise<MediaAuth | Response> {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m && m[1].trim().startsWith('eb_pat_')) {
    const v = await validateApiKey(env, m[1].trim());
    if (!v) return json({ error: 'invalid or revoked API key' }, 401);
    if (write && !hasScope(v.scopes, 'full')) return json({ error: "write requires a 'full'-scope key" }, 403);
    return { level: 'pat', scopes: v.scopes };
  }
  if (await authorizeBearer(req, env, 'media')) return { level: 'owner' };
  const s = await requireSession(req, env);
  return s.ok ? { level: 'owner' } : s.response;
}

// Delegado ao núcleo único (auth/visibility.ts, spec 91) — antes era cópia local.
function canSeePrivate(auth: MediaAuth): boolean {
  return scopesSeePrivate(auth.level === 'pat' ? auth.scopes : undefined, auth.level === 'owner');
}

// Gate de privacidade do caminho PAT (fail-closed, espelha recall/get_note): nota
// privada sem escopo 'private' → "não existe" (404). Só roda pra PAT — o fluxo do
// dono não paga a query extra nem muda de comportamento.
async function patNoteDenied(env: Env, auth: MediaAuth, noteId: string): Promise<Response | null> {
  if (auth.level !== 'pat') return null;
  const note = await getNoteById(env, noteId, false, canSeePrivate(auth));
  return note ? null : json({ error: `note '${noteId}' not found` }, 404);
}

function originOf(req: Request): string {
  return new URL(req.url).origin;
}

// POST /app/notes/{id}/media — JSON {base64|url, mime_type, kind, filename} OU multipart (file).
export async function handleMediaUpload(req: Request, env: Env, noteId: string): Promise<Response> {
  const auth = await authReq(req, env, true);
  if (auth instanceof Response) return auth;
  const privDenied = await patNoteDenied(env, auth, noteId);
  if (privDenied) return privDenied;

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
    const r = await attachMedia(env, noteId, input, Date.now(), originOf(req), canSeePrivate(auth));
    return json(r, 201);
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return json({ error: e instanceof Error ? e.message : 'upload failed' }, 500);
  }
}

// GET /app/notes/{id}/media — lista as mídias da nota (com signed URLs frescas).
export async function handleMediaList(req: Request, env: Env, noteId: string): Promise<Response> {
  const auth = await authReq(req, env);
  if (auth instanceof Response) return auth;
  const privDenied = await patNoteDenied(env, auth, noteId);
  if (privDenied) return privDenied;
  const views = await listMediaViews(env, noteId, Date.now(), originOf(req));
  return json({ note_id: noteId, count: views.length, media: views });
}

// GET /app/media/{id} — serve o blob. Auth: signed token (?t=&sig=) OU sessão/bearer.
export async function handleMediaServe(req: Request, env: Env, mediaId: string): Promise<Response> {
  const url = new URL(req.url);
  const t = Number(url.searchParams.get('t') || '0');
  const sig = url.searchParams.get('sig') || '';
  // Token assinado (link com TTL) autoriza sozinho — inclusive mídia de nota privada,
  // por design (quem tem o link temporário vê). Sem token, cai na auth normal, e o
  // caminho PAT ainda passa pelo gate de privacidade da nota dona da mídia.
  let auth: MediaAuth | null = null;
  if (sig && await verifyMediaToken(env, mediaId, t, sig, Date.now())) {
    auth = { level: 'owner' };
  } else {
    const a = await authReq(req, env);
    if (a instanceof Response) return a.status === 401 || a.status === 403 ? a : json({ error: 'unauthorized' }, 401);
    auth = a;
  }

  const media = await getMediaById(env, mediaId);
  if (!media) return json({ error: 'media not found' }, 404);
  const privDenied = await patNoteDenied(env, auth, media.note_id);
  if (privDenied) return json({ error: 'media not found' }, 404);
  const res = await fetchBlob(env, media);
  if (!res) return json({ error: 'blob missing in R2' }, 404);
  return res;
}

// DELETE /app/media/{id} — remove registro; blob R2 só se for a última referência.
export async function handleMediaDelete(req: Request, env: Env, mediaId: string): Promise<Response> {
  const auth = await authReq(req, env, true);
  if (auth instanceof Response) return auth;
  const media = await getMediaById(env, mediaId);
  if (!media) return json({ error: 'media not found' }, 404);
  const privDenied = await patNoteDenied(env, auth, media.note_id);
  if (privDenied) return json({ error: 'media not found' }, 404);
  const r = await removeMedia(env, mediaId);
  if (!r) return json({ error: 'media not found' }, 404);
  return json({ ok: true, id: mediaId, blob_removed: r.removedBlob });
}
