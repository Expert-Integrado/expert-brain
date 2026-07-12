import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { MEDIA_KINDS } from '../../db/media-queries.js';
import { attachMedia, MediaError } from '../../media/store.js';

const inputSchema = {
  note_id: z.string().min(1).describe('The note id to attach media to (from recall/get_note/save_note).'),
  source: z.string().min(1).describe('Either a base64 string (optionally a data: URL) OR an http(s) URL to fetch. Auto-detected.'),
  kind: z.enum(MEDIA_KINDS).optional().describe("image | video | document | audio. Inferred from mime if omitted."),
  mime_type: z.string().optional().describe('MIME type, e.g. image/png. Recommended for base64; inferred from response/data-url otherwise.'),
  filename: z.string().optional().describe('Original filename for display/download.'),
};

const DESCRIPTION = `Attaches a media file (image, video, document, audio) to an existing note.

The blob is stored in R2 with SHA-256 dedup (the same file attached to many notes uses one blob). \`source\` is EITHER a base64 string (a raw base64 or a data: URL) OR an http(s) URL to download (fetched with a browser User-Agent to dodge WAFs). Max 50MB.

IMPORTANT — for LOCAL files, do NOT generate base64 as text: for payloads over a few KB the model reproduces it lossily and the file corrupts SILENTLY. Prefer the direct upload endpoint (bytes never pass through the model): \`curl -sS -X POST <worker-url>/app/notes/<note_id>/media -H "Authorization: Bearer <the same eb_pat_ key used for this MCP>" -F file=@/path/to/file\` — returns the same shape (id, content_hash, signed_url); verify fidelity by comparing content_hash with your local sha256sum. A read-only key cannot upload; private notes require the 'private' scope.

Returns the media id and a signed URL (valid ~1h) to view it. Use get_note_media to list a note's media, delete_note_media to remove.

Works for tasks (kind='task') too — attaching media to a task is a legitimate operation.`;

interface AttachInput { note_id: string; source: string; kind?: typeof MEDIA_KINDS[number]; mime_type?: string; filename?: string; }

export function registerAttachMedia(server: any, env: Env): void {
  server.registerTool(
    'attach_media_to_note',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Attach media to note', resource: 'notes.media', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safeToolHandler(async (input: AttachInput) => {
      const isUrl = /^https?:\/\//i.test(input.source.trim());
      try {
        const r = await attachMedia(
          env, input.note_id,
          {
            base64: isUrl ? undefined : input.source,
            url: isUrl ? input.source.trim() : undefined,
            mime_type: input.mime_type, kind: input.kind, filename: input.filename,
          },
          Date.now(),
        );
        return toolSuccess({
          id: r.id, kind: r.kind, mime_type: r.mime_type, size_bytes: r.size_bytes,
          deduped: r.deduped, signed_url: r.signed_url,
        });
      } catch (e) {
        if (e instanceof MediaError) return toolError(e.message);
        throw e;
      }
    }) as any
  );
}
