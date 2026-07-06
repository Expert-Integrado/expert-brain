import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { RESURFACE_DIGEST_META_KEY, type ResurfaceDigest } from '../../src/digest/resurface.js';

// Card "Do seu cérebro" no topo de /app/notes (specs/50-console-v2/64-resurfacing-digest.md
// §2, fallback enquanto a home da spec 65 não existe). Lê SÓ o cache — nunca recomputa
// no request path (ver comentário em src/web/notes.ts).

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function fixtureDigest(): ResurfaceDigest {
  return {
    version: 1,
    generated_at: Date.now(),
    open_questions: [{ id: 'q1', title: 'Pergunta Card Fixture', tldr: 't', age_days: 40, url: 'https://x.test/app/notes/q1' }],
    stale_central_notes: [],
    cooling_contacts: [],
    contacts_degraded: true,
    inbox_pending_over_7d: null,
    inbox_url: 'https://x.test/app/inbox',
  };
}

async function writeDigestCache(digest: ResurfaceDigest | null): Promise<void> {
  if (digest === null) {
    await E.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).run();
    return;
  }
  await E.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(RESURFACE_DIGEST_META_KEY, JSON.stringify(digest)).run();
}

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

afterEach(async () => {
  // Nunca deixa o cache vazar pra outras suítes que compartilham este D1
  // (isolatedStorage:false — ver vitest.config.ts).
  await writeDigestCache(null);
});

describe('/app/notes — card "Do seu cérebro"', () => {
  it('cache com conteúdo → card renderiza título e link', async () => {
    await writeDigestCache(fixtureDigest());
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="resurface-digest-card"');
    expect(html).toContain('Pergunta Card Fixture');
    expect(html).toContain('href="https://x.test/app/notes/q1"');
  });

  it('sem cache → card ausente', async () => {
    await writeDigestCache(null);
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('id="resurface-digest-card"');
  });

  it('cache vazio (4 seções vazias) → card ausente', async () => {
    await writeDigestCache({
      version: 1, generated_at: Date.now(),
      open_questions: [], stale_central_notes: [], cooling_contacts: [],
      contacts_degraded: false, inbox_pending_over_7d: null, inbox_url: 'https://x.test/app/inbox',
    });
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).not.toContain('id="resurface-digest-card"');
  });

  it('página 2 (offset>0) → card ausente mesmo com cache preenchido', async () => {
    await writeDigestCache(fixtureDigest());
    const res = await SELF.fetch('https://x.test/app/notes?offset=50', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).not.toContain('id="resurface-digest-card"');
  });
});
