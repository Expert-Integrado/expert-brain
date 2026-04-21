import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolSuccess } from '../helpers.js';

const inputSchema = {
  top_domains_limit: z.number().int().min(1).max(200).optional().default(50),
};

const DESCRIPTION = `Overview of the vault: total counts, distribution by domain and by kind, and recent activity.

Returns:
- total_notes, total_edges
- notes_by_domain: [{ domain, count }] sorted by count desc, capped at top_domains_limit (default 50)
- notes_by_kind: [{ kind, count }] for the 7 canonical kinds
- recent_7d, recent_30d: number of notes created in the last 7 / 30 days

Use stats when:
- The user asks "how big is my vault?" / "how many notes do I have?" / "what are my top domains?".
- You want to show growth or composition at a teaching moment.
- You want to decide whether recall will be meaningful (a 3-note vault has little cross-domain surface).

Read-only. Cheap. No side effects.`;

interface DomainRow { domain: string; count: number; }
interface KindRow { kind: string; count: number; }

interface StatsInput { top_domains_limit?: number; }

export function registerStats(server: any, env: Env): void {
  server.registerTool(
    'stats',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Vault overview',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: StatsInput) => {
      const now = Date.now();
      const d7 = now - 7 * 24 * 60 * 60 * 1000;
      const d30 = now - 30 * 24 * 60 * 60 * 1000;
      const limit = input.top_domains_limit ?? 50;

      const [totalsRow, domainRows, kindRows] = await Promise.all([
        env.DB.prepare(
          `SELECT
             (SELECT count(*) FROM notes) AS notes,
             (SELECT count(*) FROM edges) AS edges,
             (SELECT count(*) FROM notes WHERE created_at >= ?) AS r7,
             (SELECT count(*) FROM notes WHERE created_at >= ?) AS r30`
        ).bind(d7, d30).first<{ notes: number; edges: number; r7: number; r30: number }>(),
        env.DB.prepare(
          `SELECT je.value AS domain, count(*) AS count
           FROM notes, json_each(notes.domains) je
           WHERE json_valid(notes.domains)
           GROUP BY je.value
           ORDER BY count DESC, domain ASC
           LIMIT ?`
        ).bind(limit).all<DomainRow>(),
        env.DB.prepare(
          `SELECT kind, count(*) AS count
           FROM notes
           WHERE kind IS NOT NULL
           GROUP BY kind
           ORDER BY count DESC, kind ASC`
        ).all<KindRow>(),
      ]);

      return toolSuccess({
        total_notes: totalsRow?.notes ?? 0,
        total_edges: totalsRow?.edges ?? 0,
        notes_by_domain: domainRows.results ?? [],
        notes_by_kind: kindRows.results ?? [],
        recent_7d: totalsRow?.r7 ?? 0,
        recent_30d: totalsRow?.r30 ?? 0,
      });
    }) as any
  );
}
