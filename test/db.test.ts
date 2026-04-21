import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

describe('migrations', () => {
  beforeAll(async () => {
    await runMigrations(env as any);
  });

  it('creates notes table', async () => {
    const r = await (env as any).DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='notes'`
    ).first();
    expect(r).not.toBeNull();
  });

  it('creates edges table with constraint', async () => {
    await expect(
      (env as any).DB.prepare(
        `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES ('e1','n1','n2','bogus','x',0)`
      ).run()
    ).rejects.toThrow();
  });

  it('is idempotent', async () => {
    await runMigrations(env as any);
    await runMigrations(env as any);
  });

  it('rejects INSERT of note with malformed domains JSON', async () => {
    await expect(
      (env as any).DB.prepare(
        `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
         VALUES ('bad','T','b','tl','not-json','concept',0,0)`
      ).run()
    ).rejects.toThrow();
  });

  it('accepts INSERT of note with valid domains JSON', async () => {
    await (env as any).DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
       VALUES ('ok','T','b','a tldr long enough','["biology"]','concept',0,0)`
    ).run();
    const row = await (env as any).DB.prepare('SELECT id FROM notes WHERE id = ?').bind('ok').first();
    expect(row).not.toBeNull();
  });
});
