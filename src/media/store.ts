import type { Env } from '../env.js';
import { newId } from '../util/id.js';
import {
  MEDIA_KINDS, type MediaKind, type MediaRow,
  insertMedia, getMediaById, listMediaByNote, deleteMediaById, countMediaByHashAllTables,
} from '../db/media-queries.js';
import { getNoteById } from '../db/queries.js';

// Teto de upload. Não é o "limite ideal" do produto (vídeo poderia ser maior),
// é a REALIDADE do runtime: dedup exige hashear o arquivo inteiro, o que obriga
// a bufferizar tudo na memória do Worker (~128MB). 50MB cabe com folga (raw +
// base64 + hash). Acima disso precisaria de upload multipart-stream-to-R2 SEM
// hash no servidor (hash no cliente) — fora do escopo. Erro claro acima do teto.
export const MAX_BYTES = 50 * 1024 * 1024;
const TOKEN_TTL_MS = 60 * 60 * 1000; // signed URL ~1h

const encoder = new TextEncoder();

export class MediaError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ───────────────────────── hashing / mime ─────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
  'application/zip': 'zip', 'application/json': 'json',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function extFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? 'bin';
}

// Deriva o kind canônico do mime quando o caller não passa um explícito.
export function kindFromMime(mime: string): MediaKind {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

// ───────────────────────── ingestion ─────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  // Aceita data URL (data:<mime>;base64,XXXX) ou base64 puro.
  const comma = b64.indexOf(',');
  const raw = b64.startsWith('data:') && comma >= 0 ? b64.slice(comma + 1) : b64;
  const clean = raw.replace(/\s/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mimeFromDataUrl(b64: string): string | null {
  const m = b64.match(/^data:([^;,]+)[;,]/);
  return m ? m[1] : null;
}

export interface AttachInput {
  base64?: string;
  url?: string;
  bytes?: Uint8Array;   // caminho multipart (frontend FormData) — sem inflar base64
  mime_type?: string;
  kind?: MediaKind;
  filename?: string;
}

interface IngestResult { bytes: Uint8Array; mime: string; filename: string | null; }

async function ingest(input: AttachInput): Promise<IngestResult> {
  if (input.bytes) {
    return { bytes: input.bytes, mime: input.mime_type || 'application/octet-stream', filename: input.filename ?? null };
  }
  if (input.base64) {
    let bytes: Uint8Array;
    try { bytes = base64ToBytes(input.base64); } catch { throw new MediaError(400, 'base64 decode failed'); }
    const mime = input.mime_type || mimeFromDataUrl(input.base64) || 'application/octet-stream';
    return { bytes, mime, filename: input.filename ?? null };
  }
  if (input.url) {
    let res: Response;
    try {
      // User-Agent de browser: muitos WAFs/CDNs bloqueiam fetch sem UA (bug
      // conhecido — download externo voltava 403 com o UA default do runtime).
      res = await fetch(input.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': '*/*',
        },
        redirect: 'follow',
      });
    } catch (e) {
      throw new MediaError(502, `fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new MediaError(502, `source returned HTTP ${res.status}`);
    // SSRF: o fetch roda no runtime Workers, que não alcança rede interna nem
    // metadata endpoints como um servidor tradicional — allowlist de hosts fica
    // intencionalmente fora de escopo (spec 10-backend/23).
    // content-length declarado acima do teto: rejeita antes de ler 1 byte.
    const declared = Number(res.headers.get('content-length') || '0');
    if (declared > MAX_BYTES) throw new MediaError(413, `source is ${declared} bytes — over the ${MAX_BYTES} limit`);
    // Leitura incremental: NUNCA bufferiza mais que MAX_BYTES, mesmo com
    // content-length ausente (chunked) ou mentiroso. Passou do teto → aborta o
    // stream e devolve 413 limpo em vez de OOM/1102 do isolate.
    const reader = res.body?.getReader();
    if (!reader) throw new MediaError(502, 'source returned no body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new MediaError(413, `source exceeded the ${MAX_BYTES}-byte limit while streaming — download aborted`);
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const mime = input.mime_type || (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const nameFromUrl = (() => {
      try { return decodeURIComponent(new URL(input.url!).pathname.split('/').pop() || '') || null; } catch { return null; }
    })();
    return { bytes: buf, mime, filename: input.filename ?? nameFromUrl };
  }
  throw new MediaError(400, 'provide base64 or url');
}

// ───────────────────────── signed URLs (HMAC + TTL) ─────────────────────────
// R2 via binding NÃO gera presigned URL estilo S3 (isso exige access key/secret
// da API S3 do R2, que não temos). Em vez disso: a rota /app/media/{id} é servida
// PELO Worker e aceita um token HMAC curto (assinado com SESSION_SECRET, TTL ~1h)
// — mesmo efeito (link com expiração, não público) sem credencial S3. A rota
// também aceita sessão de browser, então <img src> em página logada funciona direto.

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyMediaToken(env: Env, mediaId: string, expiresAt: number, sig: string, now: number): Promise<boolean> {
  if (!env.SESSION_SECRET) return false;
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = await hmac(env.SESSION_SECRET, `media:${mediaId}:${expiresAt}`);
  return constTimeEq(expected, sig);
}

// Caminho relativo assinado: /app/media/{id}?t=<exp>&sig=<hmac>. Se `origin` vier
// (HTTP handler tem o request), devolve URL absoluta; senão usa env.WORKER_URL;
// senão relativo (igual noteUrl).
export async function signedMediaPath(env: Env, mediaId: string, now: number, origin?: string): Promise<string> {
  const exp = now + TOKEN_TTL_MS;
  const path = env.SESSION_SECRET
    ? `/app/media/${mediaId}?t=${exp}&sig=${await hmac(env.SESSION_SECRET, `media:${mediaId}:${exp}`)}`
    : `/app/media/${mediaId}`;
  const base = (origin || env.WORKER_URL || '').replace(/\/$/, '');
  return `${base}${path}`;
}

// ───────────────────────── operations ─────────────────────────

export interface AttachResult {
  id: string;
  kind: MediaKind;
  content_hash: string;
  r2_key: string;
  size_bytes: number;
  mime_type: string;
  deduped: boolean;
  signed_url: string;
}

// Sobe um blob pro R2 com dedup por conteúdo (key = sha256/<hash>.<ext>): só faz o
// put se o blob ainda não existe. Compartilhado entre attachMedia (nota) e a mídia
// do inbox (spec 68) — a MESMA key nas duas superfícies é o que torna a triagem
// "virar nota" um re-aponte de linha, sem re-upload.
export interface StoredBlob { r2_key: string; content_hash: string; deduped: boolean; }

export async function putBlobDedup(env: Env, bytes: Uint8Array, mime: string): Promise<StoredBlob> {
  if (!env.MEDIA) throw new MediaError(503, 'R2 bucket not configured (MEDIA binding missing)');
  const hash = await sha256Hex(bytes);
  const r2Key = `sha256/${hash}.${extFromMime(mime)}`;
  const existing = await env.MEDIA.head(r2Key);
  if (!existing) {
    await env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
  }
  return { r2_key: r2Key, content_hash: hash, deduped: !!existing };
}

// canSeePrivate (spec 10-backend/25): default false mantém o contrato histórico
// (nota privada = "not found"); a sessão do dono e PAT com escopo 'private' passam
// true — sem isso nem o DONO conseguia anexar mídia em nota privada pelo console.
export async function attachMedia(env: Env, noteId: string, input: AttachInput, now: number, origin?: string, canSeePrivate = false): Promise<AttachResult> {
  if (!env.MEDIA) throw new MediaError(503, 'R2 bucket not configured (MEDIA binding missing)');

  const note = await getNoteById(env, noteId, false, canSeePrivate);
  if (!note) throw new MediaError(404, `note '${noteId}' not found`);

  const { bytes, mime, filename } = await ingest(input);
  if (bytes.length === 0) throw new MediaError(400, 'empty payload');
  if (bytes.length > MAX_BYTES) {
    throw new MediaError(413, `media is ${bytes.length} bytes — over the ${MAX_BYTES}-byte (50MB) limit. Larger files are out of scope for upload through the Worker.`);
  }

  const kind: MediaKind = (input.kind && MEDIA_KINDS.includes(input.kind)) ? input.kind : kindFromMime(mime);
  const { r2_key: r2Key, content_hash: hash, deduped } = await putBlobDedup(env, bytes, mime);

  const id = newId();
  await insertMedia(env, {
    id, note_id: noteId, kind, r2_key: r2Key, content_hash: hash,
    mime_type: mime, size_bytes: bytes.length, original_filename: filename, created_at: now,
  });

  return {
    id, kind, content_hash: hash, r2_key: r2Key, size_bytes: bytes.length, mime_type: mime,
    deduped,
    signed_url: await signedMediaPath(env, id, now, origin),
  };
}

export interface MediaView {
  id: string; kind: string; mime_type: string; size_bytes: number;
  original_filename: string | null; created_at: number; signed_url: string;
}

export async function listMediaViews(env: Env, noteId: string, now: number, origin?: string): Promise<MediaView[]> {
  const rows = await listMediaByNote(env, noteId);
  return Promise.all(rows.map(async (m) => ({
    id: m.id, kind: m.kind, mime_type: m.mime_type, size_bytes: m.size_bytes,
    original_filename: m.original_filename, created_at: m.created_at,
    signed_url: await signedMediaPath(env, m.id, now, origin),
  })));
}

// Nome de arquivo seguro pro header content-disposition: valor de header é ByteString
// (Latin-1) — qualquer code point > 255 (emoji, CJK, comum em screenshot de share
// sheet) faz headers.set() lançar TypeError e derruba a resposta inteira. Remove
// também aspas e CR/LF (header injection). Vazio após a limpeza = sem header.
export function safeDispositionFilename(name: string): string {
  return name.replace(/["\r\n]/g, '').replace(/[^\x20-\xFF]/g, '_').trim();
}

// Stream do blob R2 (auth já validada pelo handler). Retorna null se sumiu.
export async function fetchBlob(env: Env, media: MediaRow): Promise<Response | null> {
  if (!env.MEDIA) return null;
  const obj = await env.MEDIA.get(media.r2_key);
  if (!obj) return null;
  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType || media.mime_type || 'application/octet-stream');
  headers.set('cache-control', 'private, max-age=3600');
  headers.set('content-length', String(media.size_bytes));
  const safeName = media.original_filename ? safeDispositionFilename(media.original_filename) : '';
  if (safeName) {
    headers.set('content-disposition', `inline; filename="${safeName}"`);
  }
  return new Response(obj.body, { headers });
}

// Remove o registro D1; se for a ÚLTIMA referência ao content_hash (contando note_media
// E inbox_media — spec 68: as duas tabelas compartilham blobs por dedup), remove o blob R2.
export async function removeMedia(env: Env, mediaId: string): Promise<{ removedBlob: boolean } | null> {
  const media = await getMediaById(env, mediaId);
  if (!media) return null;
  await deleteMediaById(env, mediaId);
  const remaining = await countMediaByHashAllTables(env, media.content_hash);
  let removedBlob = false;
  if (remaining === 0 && env.MEDIA) {
    await env.MEDIA.delete(media.r2_key);
    removedBlob = true;
  }
  return { removedBlob };
}

export { getMediaById };
