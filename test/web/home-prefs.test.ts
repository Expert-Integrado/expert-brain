import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { sanitizeHomePrefs, HOME_BOX_MIN, HOME_BOX_MAX, HOME_PREFS_META_KEY } from '../../src/web/home-prefs.js';

// Layout das caixas da home (Onda 9b, specs/60-ux-reforma/72 + largura 19/07):
// sanitize puro (alturas + larguras + ordem) + endpoint POST /app/home/prefs +
// reflexo no SSR da home (ordem dos filhos da grid, a custom property
// --home-card-h só onde há valor e a classe .home-card-wide por card).

const E = env as any;

beforeAll(async () => {
  await runMigrations(E);
});

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('sanitizeHomePrefs (spec 72)', () => {
  it('não-objeto e shape sem heights NEM order → null', () => {
    expect(sanitizeHomePrefs(null)).toBeNull();
    expect(sanitizeHomePrefs('x')).toBeNull();
    expect(sanitizeHomePrefs({})).toBeNull();
    expect(sanitizeHomePrefs({ heights: 'x' })).toBeNull();
  });

  it('clampa alturas nos limites e arredonda', () => {
    const p = sanitizeHomePrefs({ heights: { today: 10, inbox: 5000, activity: 480.6 } })!;
    expect(p.heights.today).toBe(HOME_BOX_MIN);
    expect(p.heights.inbox).toBe(HOME_BOX_MAX);
    expect(p.heights.activity).toBe(481);
    expect(p.order).toBeNull();
  });

  it('dropa chave desconhecida e valor inválido (cai no default, nunca 400)', () => {
    const p = sanitizeHomePrefs({ heights: { today: 'abc', hacker: 300, digest: 400 } })!;
    expect(p.heights.today).toBeUndefined();
    expect((p.heights as any).hacker).toBeUndefined();
    expect(p.heights.digest).toBe(400);
  });

  it('order: só chaves conhecidas, sem duplicata, faltantes entram na POSIÇÃO default', () => {
    const p = sanitizeHomePrefs({ order: ['inbox', 'hacker', 'inbox', 'activity'] })!;
    // 'hacker' e a duplicata caem; as ausentes entram na posição que têm na
    // ordem default (não no fim) — pref antiga nunca esconde nem ENTERRA caixa
    // nova: 'pending' (rodada 6) precisa nascer no topo mesmo pra quem já tinha
    // layout salvo antes dela existir.
    expect(p.order).toEqual(['pending', 'today', 'inbox', 'digest', 'insights', 'activity']);
    expect(p.heights).toEqual({});
  });

  it('heights e order juntos no mesmo body', () => {
    const p = sanitizeHomePrefs({ heights: { today: 500 }, order: ['digest', 'today', 'inbox', 'activity'] })!;
    expect(p.heights).toEqual({ today: 500 });
    // Ordem custom preservada entre as presentes; pending entra na frente
    // (posição default 0) e insights antes de activity (posição default).
    expect(p.order).toEqual(['pending', 'digest', 'today', 'inbox', 'insights', 'activity']);
  });

  it('hidden (rodada 6): só chaves conhecidas, sem duplicata; ausente = [] (blob antigo carrega intacto)', () => {
    const p = sanitizeHomePrefs({ hidden: ['digest', 'hacker', 'digest', 'activity'] })!;
    expect(p.hidden).toEqual(['digest', 'activity']);
    expect(p.heights).toEqual({});
    expect(p.order).toBeNull();
    // Retrocompat: blob salvo ANTES da rodada 6 (sem pending nem hidden) segue
    // legível — hidden vira [] e 'pending' entra na PRIMEIRA posição (default),
    // não enterrado no fim: é a fila do dono, nasce no topo.
    const old = sanitizeHomePrefs({ heights: { today: 500 }, sizes: { insights: 'normal' }, order: ['today', 'inbox', 'digest', 'insights', 'activity'] })!;
    expect(old.hidden).toEqual([]);
    expect(old.order).toEqual(['pending', 'today', 'inbox', 'digest', 'insights', 'activity']);
    expect(old.heights).toEqual({ today: 500 });
  });

  it('sizes: só wide/normal em chave conhecida; o resto é dropado (default)', () => {
    const p = sanitizeHomePrefs({ sizes: { today: 'wide', insights: 'normal', inbox: 'gigante', hacker: 'wide' } })!;
    expect(p.sizes).toEqual({ today: 'wide', insights: 'normal' });
    expect(p.heights).toEqual({});
    expect(p.order).toBeNull();
  });

  it('pref antiga sem sizes = todos os defaults (retrocompatível)', () => {
    const p = sanitizeHomePrefs({ heights: { today: 500 } })!;
    expect(p.sizes).toEqual({});
  });
});

describe('POST /app/home/prefs + reflexo no SSR (spec 72)', () => {
  it('sem sessão → bloqueado (401 pra request JSON)', async () => {
    const res = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ heights: { today: 500 } }),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('salva altura+ordem, reflete no SSR da home; default fica sem style inline', async () => {
    const ck = await cookie();
    const res = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: { today: 500 }, order: ['inbox', 'today', 'digest', 'activity'] }),
    });
    expect(res.status).toBe(200);

    const html = await (await SELF.fetch('https://x.test/app', { headers: { cookie: ck } })).text();
    // caixa com pref salva carrega o style var; as demais ficam no fallback do CSS
    expect(html).toMatch(/data-home-box="today"[^>]* style="--home-card-h:500px"/);
    expect(html).toMatch(/data-home-box="inbox"(?![^>]*--home-card-h)/);
    // ordem salva: inbox vem ANTES de today na grid
    expect(html.indexOf('data-home-item="inbox"')).toBeLessThan(html.indexOf('data-home-item="today"'));
    // atividade é filha da grid (reordenável) e cada caixa expõe alça + limites
    expect(html).toContain('data-home-item="activity"');
    expect(html).toContain('class="home-resize"');
    expect(html).toContain('home-box-handle');
    expect(html).toMatch(/data-home-min="220"[^>]*data-home-max="960"/);
    // o modal da Onda 9 morreu (spec 72: manipulação direta)
    expect(html).not.toContain('home-prefs-modal');
    expect(html).not.toContain('home-prefs-open');

    // limpar: heights vazio + order default (chave ausente = default)
    const clear = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: {} }),
    });
    expect(clear.status).toBe(200);
    const row = await E.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(HOME_PREFS_META_KEY).first();
    expect(JSON.parse(row.value)).toEqual({ heights: {}, sizes: {}, order: null, hidden: [], startDismissed: false });
  });

  it('hidden (rodada 6): salva, reflete a classe home-card-hidden no SSR; POST sem o campo preserva', async () => {
    const ck = await cookie();
    const res = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ hidden: ['today'] }),
    });
    expect(res.status).toBe(200);
    const html = await (await SELF.fetch('https://x.test/app', { headers: { cookie: ck } })).text();
    expect(html).toMatch(/class="card home-card home-card-hidden"[^>]*data-home-item="today"/);
    // As demais caixas seguem sem a classe.
    expect(html).not.toMatch(/home-card-hidden"[^>]*data-home-item="inbox"/);

    // POST de layout SEM o campo hidden (cliente antigo) preserva o salvo.
    await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: { inbox: 500 } }),
    });
    let row = await E.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(HOME_PREFS_META_KEY).first();
    expect(JSON.parse(row.value).hidden).toEqual(['today']);

    // hidden: [] explícito LIMPA (mostrar tudo de novo).
    await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: {}, hidden: [] }),
    });
    row = await E.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(HOME_PREFS_META_KEY).first();
    expect(JSON.parse(row.value).hidden).toEqual([]);
  });

  it('reset:true (rodada 6, Restaurar padrão): apaga o layout salvo inteiro', async () => {
    const ck = await cookie();
    await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: { today: 500 }, sizes: { today: 'wide' }, order: ['inbox', 'today'], hidden: ['digest'] }),
    });
    const res = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ reset: true }),
    });
    expect(res.status).toBe(200);
    const row = await E.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(HOME_PREFS_META_KEY).first();
    expect(JSON.parse(row.value)).toEqual({ heights: {}, sizes: {}, order: null, hidden: [], startDismissed: false });
  });

  it('largura (19/07): salva sizes, reflete a classe home-card-wide no SSR; default = insights expandido', async () => {
    const ck = await cookie();

    // Sem pref salva: insights nasce expandido (default wide), today normal —
    // e todo card com toggle expõe o botão acessível.
    const before = await (await SELF.fetch('https://x.test/app', { headers: { cookie: ck } })).text();
    expect(before).toMatch(/class="card home-card home-card-wide" id="estatisticas"/);
    expect(before).toMatch(/class="card home-card"[^>]*data-home-item="today"/);
    expect(before).toContain('class="home-size-toggle"');
    expect(before).toContain('aria-label="Expandir card"');
    expect(before).toContain('aria-label="Reduzir card"');

    // Inverte: today expandido, insights normal.
    const res = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ sizes: { today: 'wide', insights: 'normal' } }),
    });
    expect(res.status).toBe(200);
    const html = await (await SELF.fetch('https://x.test/app', { headers: { cookie: ck } })).text();
    expect(html).toMatch(/class="card home-card home-card-wide"[^>]*data-home-item="today"/);
    expect(html).toMatch(/class="card home-card" id="estatisticas"/);

    // POST de layout SEM o campo sizes (cliente antigo) preserva as larguras salvas.
    await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: { inbox: 500 } }),
    });
    const row = await E.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(HOME_PREFS_META_KEY).first();
    expect(JSON.parse(row.value).sizes).toEqual({ today: 'wide', insights: 'normal' });

    // limpar: sizes vazio volta todo mundo pro default.
    await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ heights: {}, sizes: {} }),
    });
    const after = await (await SELF.fetch('https://x.test/app', { headers: { cookie: ck } })).text();
    expect(after).toMatch(/class="card home-card home-card-wide" id="estatisticas"/);
  });

  it('body inválido → 400', async () => {
    const ck = await cookie();
    const bad = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const noHeights = await SELF.fetch('https://x.test/app/home/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ nada: true }),
    });
    expect(noHeights.status).toBe(400);
  });
});
