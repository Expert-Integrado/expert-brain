import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';
import { sanitizeGraphPrefs, getGraphPrefs, GRAPH_PREFS_META_KEY } from './graph-prefs.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
async function authCookie(): Promise<string> {
  const token = await signSession('robson@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

beforeAll(async () => {
  (env as any).OWNER_EMAIL = 'robson@example.com';
  (env as any).SESSION_SECRET = SECRET;
  await runMigrations(env as any);
  await (env as any).DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(GRAPH_PREFS_META_KEY).run();
});

describe('sanitizeGraphPrefs', () => {
  it('clampa números fora de range, coage tipos e dropa chaves desconhecidas', () => {
    const p = sanitizeGraphPrefs({
      forces: { center: 99, repel: -5, link: 0.8, distance: 1000 },
      colorMode: 'inventado',
      similarOpacity: 2,
      hideSimilar: 'sim',     // tipo errado → default false
      nodeSizeMult: 0.1,      // < min 0.3
      textFadeMult: 10,       // > max 3
      noOverlap: true,
      lixo: 'ignorado',
    })!;
    expect(p.forces.center).toBe(1);      // clamp hi
    expect(p.forces.repel).toBe(0);       // clamp lo
    expect(p.forces.link).toBe(0.8);      // dentro do range, intacto
    expect(p.forces.distance).toBe(500);  // clamp hi
    expect(p.colorMode).toBe('neutral');  // enum inválido → neutral
    expect(p.similarOpacity).toBe(1);
    expect(p.hideSimilar).toBe(false);
    expect(p.nodeSizeMult).toBe(0.3);
    expect(p.textFadeMult).toBe(3);
    expect(p.noOverlap).toBe(true);
    expect((p as any).lixo).toBeUndefined();
  });

  it('retorna null pra entrada que não é objeto', () => {
    expect(sanitizeGraphPrefs(null)).toBeNull();
    expect(sanitizeGraphPrefs('x')).toBeNull();
    expect(sanitizeGraphPrefs(42)).toBeNull();
  });
});

describe('POST /app/graph/prefs', () => {
  it('exige sessão', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/prefs', { method: 'POST', body: '{}', redirect: 'manual' });
    expect([302, 401]).toContain(res.status);
  });

  it('json inválido → 400', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: 'nao-é-json',
    });
    expect(res.status).toBe(400);
  });

  it('salva e lê de volta sanitizado', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        forces: { center: 0.3, repel: 12, link: 0.8, distance: 300 },
        colorMode: 'domain', noOverlap: true, similarOpacity: 0.5,
      }),
    });
    expect(res.status).toBe(200);

    const saved = await getGraphPrefs(env as any);
    expect(saved).not.toBeNull();
    expect(saved!.colorMode).toBe('domain');
    expect(saved!.forces.distance).toBe(300);
    expect(saved!.noOverlap).toBe(true);
    expect(saved!.similarOpacity).toBe(0.5);
  });
});
