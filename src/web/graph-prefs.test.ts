import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';
import { sanitizeGraphPrefs, getGraphPrefs, GRAPH_PREFS_META_KEY } from './graph-prefs.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  (env as any).OWNER_EMAIL = 'owner@example.com';
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

  // Aditivo 2026-07: perfil 3D separado. Prefs antigas (sem forces3d) caem nos
  // defaults 3D calibrados — nada quebra; e o perfil 3D clampa nos mesmos ranges.
  it('prefs antigas sem forces3d caem nos defaults 3D (aditivo, sem quebrar)', () => {
    const p = sanitizeGraphPrefs({ forces: { center: 0.3, repel: 12, link: 0.8, distance: 300 } })!;
    expect(p.forces.center).toBe(0.3);        // perfil 2D intacto
    expect(p.forces3d).toEqual({ center: 0.2, repel: 8, link: 1, distance: 150 }); // defaults 3D
  });

  it('clampa forces3d nos mesmos ranges dos sliders', () => {
    const p = sanitizeGraphPrefs({
      forces3d: { center: 99, repel: -5, link: 0.5, distance: 1000 },
    })!;
    expect(p.forces3d.center).toBe(1);      // clamp hi
    expect(p.forces3d.repel).toBe(0);       // clamp lo
    expect(p.forces3d.link).toBe(0.5);      // dentro do range, intacto
    expect(p.forces3d.distance).toBe(500);  // clamp hi
    expect(p.forces.repel).toBe(10);        // 2D não contamina: segue default próprio
  });

  // Aditivo 2026-07: perfil visual separado (mesma motivação do forces3d acima —
  // mexer no slider "Tamanho das bolinhas" no 3D não pode afetar o 2D). Prefs
  // antigas (sem visual3d) caem nos defaults visuais 3D calibrados — nada quebra.
  it('prefs antigas sem visual3d caem nos defaults visuais 3D (aditivo, sem quebrar)', () => {
    const p = sanitizeGraphPrefs({ nodeSizeMult: 1.5, lineSizeMult: 2, textFadeMult: 1 })!;
    expect(p.nodeSizeMult).toBe(1.5);   // perfil 2D intacto
    expect(p.lineSizeMult).toBe(2);     // perfil 2D intacto
    expect(p.textFadeMult).toBe(1);     // perfil 2D intacto
    expect(p.visual3d).toEqual({ nodeSizeMult: 1, lineSizeMult: 1 }); // defaults visuais 3D
  });

  it('clampa visual3d nos mesmos ranges dos sliders', () => {
    const p = sanitizeGraphPrefs({
      visual3d: { nodeSizeMult: 99, lineSizeMult: -5 },
    })!;
    expect(p.visual3d.nodeSizeMult).toBe(3);   // clamp hi (0.3..3)
    expect(p.visual3d.lineSizeMult).toBe(0);   // clamp lo (0..3)
    expect(p.nodeSizeMult).toBe(1);            // 2D não contamina: segue default próprio
    expect(p.lineSizeMult).toBe(1);            // 2D não contamina: segue default próprio
  });

  it('salva e lê de volta visual3d sanitizado via POST /app/graph/prefs', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/prefs', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeSizeMult: 1.2, lineSizeMult: 0.8, textFadeMult: -1,
        visual3d: { nodeSizeMult: 2, lineSizeMult: 1.5 },
      }),
    });
    expect(res.status).toBe(200);

    const saved = await getGraphPrefs(env as any);
    expect(saved).not.toBeNull();
    expect(saved!.nodeSizeMult).toBe(1.2);
    expect(saved!.lineSizeMult).toBe(0.8);
    expect(saved!.textFadeMult).toBe(-1);
    expect(saved!.visual3d).toEqual({ nodeSizeMult: 2, lineSizeMult: 1.5 });
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
