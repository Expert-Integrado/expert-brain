import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolSuccess } from '../helpers.js';
import { listMediaViews } from '../../media/store.js';

const inputSchema = {
  note_id: z.string().min(1).describe('The note id whose media to list.'),
};

const DESCRIPTION = `Lists all media attached to a note. Returns each item's id, kind, mime_type, size, filename, and a signed URL (valid ~1h) to view it. Read-only.`;

interface Input { note_id: string; }

export function registerGetNoteMedia(server: any, env: Env): void {
  server.registerTool(
    'get_note_media',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'List note media', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: Input) => {
      const media = await listMediaViews(env, input.note_id, Date.now());
      return toolSuccess({ note_id: input.note_id, count: media.length, media });
    }) as any
  );
}
