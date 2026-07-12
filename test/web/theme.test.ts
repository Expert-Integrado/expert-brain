import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { TOKENS_CSS, THEME_COLOR, THEME_COLOR_LIGHT } from '../../src/web/styles.js';

// Tema claro (specs/91-experiencia-premium/96): segunda cartela de tokens em
// [data-theme="light"], boot script anti-flash servido de /app/theme-boot.js
// (CSP script-src 'self' proíbe inline no head — o script é um asset bloqueante
// minúsculo ANTES do stylesheet), theme-color dinâmico e toggle na sidebar.

const E = env as any;
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('cartela clara (spec 96 §1)', () => {
  it('TOKENS_CSS tem o bloco [data-theme="light"] sobrescrevendo primitivas e semânticas', () => {
    expect(TOKENS_CSS).toContain('[data-theme="light"]');
    const light = TOKENS_CSS.slice(TOKENS_CSS.indexOf('[data-theme="light"]'));
    for (const tok of ['--bg:', '--text:', '--surface:', '--surface-2:', '--accent-lav:', '--danger:', '--surface-canvas:', '--bg-gradient:']) {
      expect(light).toContain(tok);
    }
  });

  it('THEME_COLOR_LIGHT exportado espelha o --bg claro', () => {
    expect(THEME_COLOR_LIGHT).toMatch(/^#[0-9a-f]{6}$/i);
    expect(THEME_COLOR_LIGHT).not.toBe(THEME_COLOR);
    const light = TOKENS_CSS.slice(TOKENS_CSS.indexOf('[data-theme="light"]'));
    expect(light).toContain(`--bg: ${THEME_COLOR_LIGHT}`);
  });
});

describe('boot anti-flash (spec 96 §2)', () => {
  it('/app/theme-boot.js serve o script que carimba data-theme antes do primeiro paint', async () => {
    const res = await SELF.fetch('https://x.test/app/theme-boot.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const js = await res.text();
    expect(js).toContain('localStorage');
    expect(js).toContain('data-theme');
    expect(js).toContain('prefers-color-scheme');
  });

  it('shell carrega o boot ANTES do stylesheet, sem defer', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    const boot = html.indexOf('/app/theme-boot.js');
    const css = html.indexOf('/app/styles.css');
    expect(boot).toBeGreaterThan(-1);
    expect(css).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(css);
    const bootTag = html.slice(html.lastIndexOf('<script', boot), html.indexOf('</script>', boot));
    expect(bootTag).not.toContain('defer');
  });
});

describe('theme-color e toggle (spec 96 §3-4)', () => {
  it('head tem os DOIS metas de theme-color (media light + default dark)', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain(`content="${THEME_COLOR_LIGHT}"`);
    expect(html).toContain(`content="${THEME_COLOR}"`);
    expect(html).toContain('media="(prefers-color-scheme: light)"');
  });

  it('sidebar tem o botão de tema (data-theme-toggle)', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('data-theme-toggle');
  });
});
