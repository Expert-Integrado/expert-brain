import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { removeMedia } from '../../media/store.js';

const inputSchema = {
  media_id: z.string().min(1).describe('The media id to remove (from get_note_media).'),
};

const DESCRIPTION = `Removes a media item from a note. Deletes the D1 record; the R2 blob is deleted only if this was the LAST reference to it (SHA-256 dedup — other notes sharing the same file keep working). Use the media id from get_note_media.`;

interface Input { media_id: string; }

export function registerDeleteNoteMedia(server: any, env: Env): void {
  server.registerTool(
    'delete_note_media',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Delete note media', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safeToolHandler(async (input: Input) => {
      const r = await removeMedia(env, input.media_id);
      if (!r) return toolError(`Media '${input.media_id}' not found. Confirm the id via get_note_media. Do NOT retry with this id.`);
      return toolSuccess({ ok: true, id: input.media_id, blob_removed: r.removedBlob });
    }) as any
  );
}
