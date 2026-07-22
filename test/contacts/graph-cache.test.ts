import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { serializeGraphParams, contactsSourceHash } from '../../src/contacts/vaults/contacts';

// Serialização canônica dos params (chave de cache) e hash de auto-invalidação.

describe('serializeGraphParams', () => {
  it('ordem fixa q,focus,depth,all,limit,priv', () => {
    const s = serializeGraphParams({ q: 'foo', focus: 'n1', depth: 2, all: false, limit: 10 });
    expect(s).toBe('q=foo&focus=n1&depth=2&all=&limit=10&priv=');
  });

  it('params ausentes viram string vazia', () => {
    expect(serializeGraphParams({})).toBe('q=&focus=&depth=&all=&limit=&priv=');
  });

  it("all: true => '1'", () => {
    expect(serializeGraphParams({ all: true })).toBe('q=&focus=&depth=&all=1&limit=&priv=');
  });

  it('includePrivate: true => priv=1 (separa cache do dono do público)', () => {
    expect(serializeGraphParams({ includePrivate: true })).toBe('q=&focus=&depth=&all=&limit=&priv=1');
  });

  it('determinístico — mesma entrada, mesma saída', () => {
    const p = { q: 'x', limit: 5 };
    expect(serializeGraphParams(p)).toBe(serializeGraphParams(p));
  });
});

describe('contactsSourceHash', () => {
  it('banco vazio => hash estável e determinístico', async () => {
    const h1 = await contactsSourceHash(env);
    const h2 = await contactsSourceHash(env);
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('string');
    expect(h1.length).toBeGreaterThan(0);
  });

  it('muda após inserir uma entity (mecanismo de auto-invalidação do cache KV)', async () => {
    const before = await contactsSourceHash(env);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source, created_at, updated_at)
       VALUES (?, 'person', 'Hash Probe', 'test', datetime('now'), datetime('now', '+1 second'))`
    ).bind(id).run();
    const after = await contactsSourceHash(env);
    expect(after).not.toBe(before);
    // cleanup pra não poluir os counts de outros testes
    await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(id).run();
  });
});
