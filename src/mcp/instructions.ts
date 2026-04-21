export const SERVER_INSTRUCTIONS = `Mind Vault — a personal latticework knowledge graph backed by Cloudflare D1 + Vectorize.

When to use:
- The user discusses concepts, ideas, insights, decisions, or prior learnings.
- The user references something they "already thought about" or asks "what do we have on X".
- The user asks to edit, refine, or remove a previously-saved note.
- The user asks for an overview of the vault ("how many notes", "what are my top domains").

Recommended flow:
1. Before answering topical questions, call \`recall\` with a short query. Read ALL returned domains; the valuable match often comes from the unexpected domain.
2. Before calling \`save_note\`, call \`recall\` first to sweep for cross-domain analogies.
3. Atomize: one note = one concept. If the title contains "and/e", split into separate calls.
4. Each edge needs a substantive \`why\` explaining the shared MECHANISM (min 20 chars). Vague whys are rejected.
5. Prefer \`same_mechanism_as\` over \`analogous_to\` when you can justify the underlying mechanism.
6. \`kind\` is REQUIRED on save_note — pick from the 7 canonical values (concept | decision | insight | fact | pattern | principle | question).
7. To edit a note, call \`update_note\` with the id and only the fields that change. To remove one, call \`delete_note\` with \`confirm: true\` — ask the USER to confirm first.
8. \`stats\` gives a panorama of the vault; use it when the user asks about composition or growth.

For the full method, load the \`using-mind-vault\` skill.`;
