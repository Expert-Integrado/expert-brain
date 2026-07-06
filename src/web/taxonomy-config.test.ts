import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';
import {
  sanitizeTaxonomyConfig,
  getTaxonomyConfig,
  mergedDomainSlugs,
  TAXONOMY_META_KEY,
} from './taxonomy-config.js';
import { EMPTY_TAXONOMY_CONFIG } from './domain-colors.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

describe('sanitizeTaxonomyConfig — casos válidos', () => {
  it('objeto vazio (domains/kinds omitidos): config vazia, válida', () => {
    const r = sanitizeTaxonomyConfig({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toEqual({ domains: {}, kinds: {} });
  });

  it('domínio canônico + kind canônico customizados: passa e normaliza cor pra minúsculo', () => {
    const r = sanitizeTaxonomyConfig({
      domains: { management: { label: 'Gestão', color: '#ABCDEF' } },
      kinds: { decision: { label: 'Decisão', color: '#F59E0B' } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.domains.management).toEqual({ label: 'Gestão', color: '#abcdef' });
      expect(r.config.kinds.decision).toEqual({ label: 'Decisão', color: '#f59e0b' });
    }
  });

  it('área pré-criada fora do canon (mas slug sintaticamente válido) é aceita', () => {
    const r = sanitizeTaxonomyConfig({ domains: { 'vida-pessoal': { label: 'Vida Pessoal', color: '#22c55e' } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.domains['vida-pessoal']).toEqual({ label: 'Vida Pessoal', color: '#22c55e' });
  });
});

describe('sanitizeTaxonomyConfig — casos inválidos (rejeita o payload INTEIRO)', () => {
  it('não é objeto → erro', () => {
    expect(sanitizeTaxonomyConfig(null).ok).toBe(false);
    expect(sanitizeTaxonomyConfig('x').ok).toBe(false);
    expect(sanitizeTaxonomyConfig(42).ok).toBe(false);
  });

  it('slug de área com maiúscula → erro', () => {
    const r = sanitizeTaxonomyConfig({ domains: { Management: { label: 'x', color: '#111111' } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Management');
  });

  it('slug de área com acento → erro', () => {
    const r = sanitizeTaxonomyConfig({ domains: { 'vida-pessoál': { label: 'x', color: '#111111' } } });
    expect(r.ok).toBe(false);
  });

  it('cor malformada (sem #, tamanho errado, não-hex) → erro', () => {
    for (const bad of ['123456', '#12345', '#gggggg', 'red']) {
      const r = sanitizeTaxonomyConfig({ domains: { management: { label: 'Gestão', color: bad } } });
      expect(r.ok).toBe(false);
    }
  });

  it('label vazio → erro', () => {
    const r = sanitizeTaxonomyConfig({ domains: { management: { label: '   ', color: '#111111' } } });
    expect(r.ok).toBe(false);
  });

  it('label acima de 40 chars → erro', () => {
    const r = sanitizeTaxonomyConfig({ domains: { management: { label: 'x'.repeat(41), color: '#111111' } } });
    expect(r.ok).toBe(false);
  });

  it('kind fora dos 7 canônicos → erro, mesmo com label/cor válidos', () => {
    const r = sanitizeTaxonomyConfig({ kinds: { task: { label: 'Tarefa', color: '#111111' } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('task');
  });

  it('um item inválido no meio de vários válidos rejeita o payload INTEIRO (nada parcial)', () => {
    const r = sanitizeTaxonomyConfig({
      domains: {
        management: { label: 'Gestão', color: '#111111' },
        sales: { label: 'Vendas', color: '#222222' },
        'ruim!!': { label: 'x', color: '#333333' },
      },
    });
    expect(r.ok).toBe(false);
  });

  it('mais de 64 áreas → erro', () => {
    const domains: Record<string, { label: string; color: string }> = {};
    for (let i = 0; i < 65; i++) domains[`area-teste-${i}`] = { label: `Area ${i}`, color: '#111111' };
    const r = sanitizeTaxonomyConfig({ domains });
    expect(r.ok).toBe(false);
  });
});

describe('getTaxonomyConfig', () => {
  it('sem chave no meta: retorna config vazia', async () => {
    await E.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(TAXONOMY_META_KEY).run();
    expect(await getTaxonomyConfig(E)).toEqual(EMPTY_TAXONOMY_CONFIG);
  });

  it('valor corrompido (JSON inválido) no meta: cai no vazio, não lança', async () => {
    await E.DB.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(TAXONOMY_META_KEY, 'não é json{{{').run();
    expect(await getTaxonomyConfig(E)).toEqual(EMPTY_TAXONOMY_CONFIG);
  });

  it('lê de volta o que foi salvo e sanitizado', async () => {
    await E.DB.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(TAXONOMY_META_KEY, JSON.stringify({ domains: { management: { label: 'Gestão', color: '#123456' } }, kinds: {} })).run();
    const config = await getTaxonomyConfig(E);
    expect(config.domains.management).toEqual({ label: 'Gestão', color: '#123456' });
  });
});

describe('mergedDomainSlugs', () => {
  it('sem config nem extra: só os 12 canônicos, na ordem canônica', () => {
    const slugs = mergedDomainSlugs(EMPTY_TAXONOMY_CONFIG);
    expect(slugs).toContain('management');
    expect(slugs).toHaveLength(12);
  });

  it('inclui áreas pré-criadas da config + extras, sem duplicar canônicos', () => {
    const config = { domains: { 'vida-pessoal': { label: 'Vida Pessoal', color: '#22c55e' } }, kinds: {} };
    const slugs = mergedDomainSlugs(config, ['management', 'legado-fora-do-canon']);
    expect(slugs.filter((s) => s === 'management')).toHaveLength(1); // não duplica
    expect(slugs).toContain('vida-pessoal');
    expect(slugs).toContain('legado-fora-do-canon');
  });
});

describe('POST /app/config/taxonomy (sessão obrigatória, atômico)', () => {
  it('sem sessão: 401 (accept json) ou 302', async () => {
    const res = await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ domains: {}, kinds: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('json inválido → 400', async () => {
    const res = await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: 'não é json',
    });
    expect(res.status).toBe(400);
  });

  it('payload inválido → 400 com mensagem clara, e NADA é persistido (config anterior intacta)', async () => {
    await E.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(TAXONOMY_META_KEY).run();
    // Salva um estado válido primeiro.
    const ok = await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { management: { label: 'Gestão', color: '#123456' } }, kinds: {} }),
    });
    expect(ok.status).toBe(200);

    // Agora manda um payload com UMA entrada ruim junto de uma boa.
    const bad = await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        domains: {
          sales: { label: 'Vendas', color: '#222222' },
          management: { label: 'Gestão nova', color: 'não-e-cor' },
        },
      }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as any;
    expect(typeof body.error).toBe('string');

    // Config no banco continua a ANTERIOR (nem 'sales' entrou, nem 'management' mudou).
    const after = await getTaxonomyConfig(E);
    expect(after.domains.management).toEqual({ label: 'Gestão', color: '#123456' });
    expect(after.domains.sales).toBeUndefined();
  });

  it('POST válido persiste e GET devolve a mesma config', async () => {
    const payload = { domains: { marketing: { label: 'Marketing', color: '#ec4899' } }, kinds: { insight: { label: 'Insight', color: '#f472b6' } } };
    const post = await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(post.status).toBe(200);

    const get = await SELF.fetch('https://x.test/app/config/taxonomy', {
      headers: { cookie: await authCookie(), accept: 'application/json' },
    });
    expect(get.status).toBe(200);
    const config = (await get.json()) as any;
    expect(config.domains.marketing).toEqual({ label: 'Marketing', color: '#ec4899' });
    expect(config.kinds.insight).toEqual({ label: 'Insight', color: '#f472b6' });
  });
});

describe('POST /app/config/taxonomy/reset', () => {
  it('sem sessão: 401', async () => {
    const res = await SELF.fetch('https://x.test/app/config/taxonomy/reset', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('apaga a chave inteira — depois do reset, getTaxonomyConfig volta vazio (100% paleta compilada)', async () => {
    await SELF.fetch('https://x.test/app/config/taxonomy', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ domains: { management: { label: 'Gestão', color: '#123456' } }, kinds: {} }),
    });
    expect((await getTaxonomyConfig(E)).domains.management).toBeTruthy();

    const reset = await SELF.fetch('https://x.test/app/config/taxonomy/reset', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
    });
    expect(reset.status).toBe(200);
    expect(await getTaxonomyConfig(E)).toEqual(EMPTY_TAXONOMY_CONFIG);
  });
});
