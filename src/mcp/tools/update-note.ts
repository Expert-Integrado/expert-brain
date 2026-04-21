import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { NOTE_KINDS, type NoteKind, getNoteById, updateNote, replaceTags } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { embed, upsertNoteVector } from '../../vector/index.js';

const inputSchema = {
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  tldr: z.string().min(10).max(280).optional(),
  domains: z.array(z.string().min(1)).min(1).max(3).optional(),
  kind: z.enum(NOTE_KINDS as unknown as [string, ...string[]]).optional(),
  tags: z.array(z.string()).optional(),
};

const DESCRIPTION = `Edits fields of an existing note. At least one field besides id must be provided.

Editable fields: title, body, tldr, domains, kind, tags.
NOT editable here: id, created_at, edges. To change edges, use link (add) — edges cannot be deleted via MCP yet.

FLOW: call recall() or get_note() first to confirm the id. Do not call update_note with an invented id.

REEMBEDDING: the vector index is updated automatically when tldr, domains, or kind changes (the embedding is computed from tldr and the metadata carries domains+kind). If only title/body/tags changes, no Workers AI call happens — cheap edit.

VALIDATION: domains must be canonical English kebab-case slugs (same rules as save_note). kind must be one of the 7 canonical values (concept, decision, insight, fact, pattern, principle, question). tldr stays under the Feynman test — one concrete sentence, 10-280 chars.

INDEXING LATENCY: if tldr/domains/kind changed, recall may take ~1-2 minutes to reflect the new content. get_note returns the fresh values immediately.`;

interface UpdateNoteInput {
  id: string;
  title?: string;
  body?: string;
  tldr?: string;
  domains?: string[];
  kind?: NoteKind;
  tags?: string[];
}

export function registerUpdateNote(server: any, env: Env): void {
  server.registerTool(
    'update_note',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Update existing note',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: UpdateNoteInput) => {
      const { id, title, body, tldr, domains, kind, tags } = input;
      const touchesD1 = title !== undefined || body !== undefined || tldr !== undefined
        || domains !== undefined || kind !== undefined;
      if (!touchesD1 && tags === undefined) {
        return toolError(
          `update_note requires at least one field besides id to be provided. ` +
          `Editable fields: title, body, tldr, domains, kind, tags.`
        );
      }

      const existing = await getNoteById(env, id);
      if (!existing) {
        return toolError(
          `Note '${id}' not found in the vault. Call recall() or get_note() to confirm the id. Do NOT retry with this id.`
        );
      }

      if (domains !== undefined) {
        const err = validateDomains(domains);
        if (err) return toolError(err);
      }

      const now = Date.now();
      const fieldsChanged: string[] = [];
      const vectorMetadataChanged = (domains !== undefined && JSON.stringify(domains) !== existing.domains)
        || (kind !== undefined && kind !== existing.kind);
      const tldrChanged = tldr !== undefined && tldr !== existing.tldr;
      const needsReembed = tldrChanged || vectorMetadataChanged;

      if (touchesD1) {
        await updateNote(env, id, {
          title,
          body,
          tldr,
          domains: domains !== undefined ? JSON.stringify(domains) : undefined,
          kind,
          updated_at: now,
        });
        if (title !== undefined && title !== existing.title) fieldsChanged.push('title');
        if (body !== undefined && body !== existing.body) fieldsChanged.push('body');
        if (tldrChanged) fieldsChanged.push('tldr');
        if (domains !== undefined && JSON.stringify(domains) !== existing.domains) fieldsChanged.push('domains');
        if (kind !== undefined && kind !== existing.kind) fieldsChanged.push('kind');
      }

      if (tags !== undefined) {
        await replaceTags(env, id, tags);
        fieldsChanged.push('tags');
      }

      let reembedded = false;
      if (needsReembed) {
        const finalTldr = tldr ?? existing.tldr;
        const finalDomains: string[] = domains ?? JSON.parse(existing.domains);
        const finalKind: NoteKind = (kind ?? existing.kind) as NoteKind;
        const vec = await embed(env, finalTldr);
        await upsertNoteVector(env, id, vec, {
          domains: finalDomains,
          kind: finalKind,
          created_at: existing.created_at,
        });
        reembedded = true;
      }

      return toolSuccess({
        id,
        updated: true,
        fields_changed: fieldsChanged,
        reembedded,
      });
    }) as any
  );
}
