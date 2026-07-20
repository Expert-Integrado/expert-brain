import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// Busca no celular (specs/91-experiencia-premium/93-busca-mobile.md): a command
// palette precisa de gatilho SEM teclado físico — lupa ícone-só no CABEÇALHO da
// sidebar, na linha da marca (revisão 19/07: o item "Buscar" saiu da lista do
// menu) e lupa na bottom-nav (mobile), ambos marcados com data-cmd-open
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
  it('sidebar tem a lupa no cabeçalho (data-cmd-open na linha da marca), com hint Ctrl+K', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();

    const sidebar = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('</aside>'));
    expect(sidebar).toContain('data-cmd-open');
    expect(sidebar).toContain('aria-label="Buscar"');
    expect(sidebar).toContain('Ctrl+K');
    // A lupa mora DENTRO do cabeçalho (mesma linha do "Expert Brain"), acima
    // dos itens do menu — e o item de lista "Buscar" morreu (revisão 19/07).
    const logo = sidebar.slice(sidebar.indexOf('<div class="logo">'), sidebar.indexOf('</div>'));
    expect(logo).toContain('logo-search');
    expect(logo).toContain('data-cmd-open');
    expect(sidebar).not.toContain('nav-search');
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
