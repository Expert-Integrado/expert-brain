import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations } from './migrate.js';
import { deleteNote, restoreNote, getNoteById, ftsSearch } from './queries.js';
import { getVaultStatus } from '../auth/setup.js';

const E = env as any;
const ID = 'softdel-zebra';

beforeAll(async () => {
  await runMigrations(E);
  await E.DB.prepare(
    `INSERT OR REPLACE INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
     VALUES (?, 'ZebraUnique', 'corpo zebra', 'resumo zebra', '["infra"]', NULL, 1, 1)`
  ).bind(ID).run();
});

describe('soft-delete', () => {
  it('nota some de todos os read paths mas a linha sobrevive e restaura', async () => {
    // --- antes do delete: visível ---
    expect(await getNoteById(E, ID)).not.toBeNull();
    const ftsBefore = await ftsSearch(E, 'ZebraUnique', 10);
    expect(ftsBefore.some((r) => r.id === ID)).toBe(true);
    const statBefore = await getVaultStatus(E);

    // --- soft-delete ---
    await deleteNote(E, ID);

    // some do getNoteById normal
    expect(await getNoteById(E, ID)).toBeNull();
    // some do FTS (o gotcha: a linha continua no índice external-content, tem que filtrar)
    const ftsAfter = await ftsSearch(E, 'ZebraUnique', 10);
    expect(ftsAfter.some((r) => r.id === ID)).toBe(false);
    // some da contagem do vault
    const statAfter = await getVaultStatus(E);
    expect(statAfter.notes).toBe(statBefore.notes - 1);
    // MAS a linha continua no D1 (recuperável) e visível com includeDeleted
    const raw = await E.DB.prepare(`SELECT count(*) c FROM notes WHERE id=?`).bind(ID).first<{ c: number }>();
    expect(raw?.c).toBe(1);
    const trashed = await getNoteById(E, ID, true);
    expect(trashed).not.toBeNull();
    expect(trashed!.deleted_at).toBeTruthy();

    // --- restore: volta pra todos os read paths ---
    await restoreNote(E, ID);
    expect(await getNoteById(E, ID)).not.toBeNull();
    const ftsRestored = await ftsSearch(E, 'ZebraUnique', 10);
    expect(ftsRestored.some((r) => r.id === ID)).toBe(true);
    const statRestored = await getVaultStatus(E);
    expect(statRestored.notes).toBe(statBefore.notes);
  });
});
