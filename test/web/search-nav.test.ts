import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// Busca no celular (specs/91-experiencia-premium/93-busca-mobile.md): a command
// palette precisa de gatilho SEM teclado físico — caixinha "Buscar · Ctrl K"
// fixa em linha própria logo abaixo da marca (revisão 20/07 v2; recolhida vira
// lupa ícone-só) e lupa na bottom-nav (mobile), ambos marcados com
// data-cmd-open (o shell bundle delega o click pra openPalette). Testa o HTML
// do shell, igual em toda página /app/* — a home serve de amostra.

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
  it('sidebar tem a lupa minimizada abaixo da marca (side-search data-cmd-open), com hint Ctrl+K', async () => {
    const res = await SELF.fetch('https://x.test/app', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();

    const sidebar = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('</aside>'));
    expect(sidebar).toContain('data-cmd-open');
    expect(sidebar).toContain('aria-label="Buscar"');
    expect(sidebar).toContain('Ctrl+K');
    // A caixinha mora em linha PRÓPRIA entre a marca e os itens do menu
    // (revisão 20/07 v2): a marca fica sozinha na linha dela (sem quebrar em
    // duas) e o botão .side-search carrega rótulo "Buscar" + kbd Ctrl K.
    const logo = sidebar.slice(sidebar.indexOf('<div class="logo">'), sidebar.indexOf('</div>'));
    expect(logo).not.toContain('data-cmd-open');
    expect(sidebar).toMatch(/<button class="side-search"[^>]*data-cmd-open/);
    expect(sidebar).toContain('side-search-label');
    expect(sidebar).not.toContain('nav-search');
    expect(sidebar.indexOf('<div class="logo">')).toBeLessThan(sidebar.indexOf('side-search'));
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
