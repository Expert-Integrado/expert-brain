import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// Busca no celular (specs/91-experiencia-premium/93-busca-mobile.md): a command
// palette precisa de gatilho SEM teclado físico — botão "Buscar" na sidebar
// (desktop) e lupa na bottom-nav (mobile), ambos marcados com data-cmd-open
// (o shell bundle delega o click pra openPalette). Testa o HTML do shell, que é
// igual em toda página /app/* — a home serve de amostra.

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

describe('gatilhos da palette sem teclado (spec 93)', () => {
  it('sidebar tem o botão Buscar (data-cmd-open) antes de Início, com hint Ctrl+K', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();

    const sidebar = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('</aside>'));
    expect(sidebar).toContain('data-cmd-open');
    expect(sidebar).toContain('Buscar');
    expect(sidebar).toContain('Ctrl+K');
    // Acima de Início (spec 93 §1): o botão vem antes do link da home.
    expect(sidebar.indexOf('data-cmd-open')).toBeLessThan(sidebar.indexOf('href="/app"'));
  });

  it('bottom-nav (mobile) tem a lupa como botão data-cmd-open', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    const html = await res.text();

    const nav = html.slice(html.indexOf('<nav class="bottom-nav"'), html.indexOf('</nav>'));
    expect(nav).toContain('data-cmd-open');
    expect(nav).toContain('aria-label="Buscar"');
    // É button (dispara JS), não link de navegação.
    expect(nav).toMatch(/<button[^>]*data-cmd-open/);
  });

  it('sidebar e bottom-nav têm exatamente 1 gatilho cada (páginas podem somar CTAs próprios)', async () => {
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    const sidebar = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('</aside>'));
    const nav = html.slice(html.indexOf('<nav class="bottom-nav"'), html.indexOf('</nav>'));
    expect(sidebar.split('data-cmd-open').length - 1).toBe(1);
    expect(nav.split('data-cmd-open').length - 1).toBe(1);
  });
});
