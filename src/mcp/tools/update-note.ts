import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { KNOWLEDGE_KINDS, type NoteKind, getNoteById, updateNote, replaceTags } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { embed, upsertNoteVector } from '../../vector/index.js';
import { refreshSimilarEdges } from '../../web/similarity.js';

const inputSchema = {
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  tldr: z.string().min(10).max(280).optional(),
  domains: z.array(z.string().min(1)).min(1).max(3).optional().describe('Canonical English slugs (1-3). Must be one of the 12 canonical domains unless allow_new_domain is set.'),
  kind: z.enum(KNOWLEDGE_KINDS).optional().describe(
    'concept | decision | insight | fact | pattern | principle | question'
  ),
  tags: z.array(z.string()).optional(),
  allow_new_domain: z.boolean().optional().describe(
    'Escape hatch — set true to allow domains outside the 12 canonical ones. Default false. Only use when the user explicitly opens a new area.'
  ),
};

const DESCRIPTION = `Edits fields of an existing note. At least one field besides id must be provided.

Editable fields: title, body, tldr, domains, kind, tags.
NOT editable here: id, created_at, edges. To change edges, use link (add) or delete_link (remove); to edit a why, delete_link then link again.

FLOW: call recall() or get_note() first to confirm the id. Do not call update_note with an invented id.

REEMBEDDING: the vector index is updated automatically when tldr, domains, or kind changes (the embedding is computed from tldr and the metadata carries domains+kind). If only title/body/tags changes, no Workers AI call happens — cheap edit.

VALIDATION: domains must be one of the 12 canonical domains (management, sales, marketing, education, ai-applied, leadership, product, operations, personal-development, entrepreneurship, music, cognitive-science). To intentionally introduce a non-canonical domain, pass allow_new_domain: true. tldr stays under the Feynman test — one concrete sentence, 10-280 chars.

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
  allow_new_domain?: boolean;
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

      // Tasks (kind='task') NÃO se editam por aqui: update_note re-embeda em
      // mudança de tldr/domains, e task de propósito não tem vetor. Use as tools
      // de task (complete_task pra concluir; o Kanban /app/tasks pro resto).
      if (existing.kind === 'task') {
        return toolError(
          `Note '${id}' is a task (kind='task'), not a knowledge note. Edit tasks via complete_task ` +
          `(to finish) or the /app/tasks board — update_note is for knowledge notes only.`
        );
      }

      if (domains !== undefined) {
        const err = validateDomains(domains, {
          allowNewDomain: input.allow_new_domain ?? false,
        });
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
        // tldr mudou → vizinhança semântica mudou: recomputa as similar edges
        // desta nota. Best-effort (a edição já está persistida em D1).
        try {
          await refreshSimilarEdges(env, id, vec);
        } catch (err) {
          console.error('update_note: refreshSimilarEdges failed (edit persisted anyway)', err);
        }
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
