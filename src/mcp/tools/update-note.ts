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
  kind: z.enum(NOTE_KINDS).optional().describe(
    'concept | decision | insight | fact | pattern | principle | question'
  ),
  tags: z.array(z.string()).optional(),
};

const DESCRIPTION = `Edits fields of an existing note. At least one field besides id must be provided.

Editable fields: title, body, tldr, domains, kind, tags.
NOT editable here: id, created_at, edges. To change edges, use link (add) — edges cannot be deleted via MCP yet.

FLOW: call recall() or get_note() first to confirm the id. Do not call update_note with an invented id.

REEMBEDDING: the vector index is updated automatically when tldr, domains, or kind changes (the embedding is computed from tldr and the metadata carries domains+kind). If only title/body/tags changes, no Workers AI call happens — cheap edit.

VALIDATION: domains must be canonical English kebab-case slugs (same rules as save_note). tldr stays under the Feynman test — one concrete sentence, 10-280 chars.

KIND VALUES: the kind field is optional here (omit to keep existing), but if provided must be one of the 7 canonical values — pick the one that best fits the note's epistemic status:
- 'concept'   — an abstract idea, model, or framework (most common default)
- 'decision'  — a choice made with preserved reasoning (design decision, strategic bet)
- 'insight'   — a personal observation or discovery ("I just realized...")
- 'fact'      — an objective data point or citable reference
- 'pattern'   — a recurring structure observed across instances
- 'principle' — a personal rule or axiom the user lives by
- 'question'  — an open question worth revisiting (not yet answered)

DOMAIN ORDER IS SIGNIFICANT: reordering domains counts as a change and triggers a reembed. recall treats the FIRST domain as the note's primary bucket for balancing, so reordering changes retrieval behavior.

TAGS: passing an empty array (\`tags: []\`) clears all tags on the note. Omitting the tags field leaves existing tags untouched.

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
      const touchesD1Columns = title !== undefined || body !== undefined || tldr !== undefined
        || domains !== undefined || kind !== undefined;
      if (!touchesD1Columns && tags === undefined) {
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

      const titleChanged = title !== undefined && title !== existing.title;
      const bodyChanged = body !== undefined && body !== existing.body;
      const tldrChanged = tldr !== undefined && tldr !== existing.tldr;
      const domainsChanged = domains !== undefined && JSON.stringify(domains) !== existing.domains;
      const kindChanged = kind !== undefined && kind !== existing.kind;
      const needsReembed = tldrChanged || domainsChanged || kindChanged;

      const now = Date.now();
      const fieldsChanged: string[] = [];

      if (touchesD1Columns) {
        await updateNote(env, id, {
          title, body, tldr,
          domains: domains !== undefined ? JSON.stringify(domains) : undefined,
          kind,
          updated_at: now,
        });
        if (titleChanged) fieldsChanged.push('title');
        if (bodyChanged) fieldsChanged.push('body');
        if (tldrChanged) fieldsChanged.push('tldr');
        if (domainsChanged) fieldsChanged.push('domains');
        if (kindChanged) fieldsChanged.push('kind');
      }

      if (tags !== undefined) {
        await replaceTags(env, id, tags);
        // Ensure updated_at advances even when only tags changed — downstream
        // code treats notes.updated_at as the "this note was edited" signal.
        if (!touchesD1Columns) {
          await updateNote(env, id, { updated_at: now });
        }
        fieldsChanged.push('tags');
      }

      let reembedded = false;
      if (needsReembed) {
        const finalTldr = tldr ?? existing.tldr;
        const finalDomains: string[] = domains ?? JSON.parse(existing.domains);
        // Legacy rows may have kind = null; preserve that through to Vectorize
        // metadata instead of forcing a NoteKind cast on a null.
        const finalKind: string | null = kind ?? existing.kind;
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
