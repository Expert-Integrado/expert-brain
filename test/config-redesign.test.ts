// Redesign da /app/config (pedido 11/07): 4 abas (Agentes / Integrações /
// Organização / Sistema) no lugar das 3 antigas; usuários migram de Organização
// pra Agentes; as 4 integrações externas (Google, WhatsApp, Instagram, Pipedrive)
// viram cards com status dot numa aba própria; card de agente ganha botão
// "Criar chave" que abre #api-keys pré-preenchido. Zero mudança de backend —
// só apresentação. Dados sempre fictícios (repo público).
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { signSession } from '../src/web/session.js';
import { configPageScript } from '../src/web/config-script.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function fetchConfig(qs = ''): Promise<string> {
  const res = await SELF.fetch(`https://x/app/config${qs}`, { headers: { cookie: await cookie() } });
  expect(res.status).toBe(200);
  return res.text();
}

// A aba `slug` está selecionada no primeiro paint? (formato fixo do tabButton)
const tabSelected = (html: string, slug: string): boolean =>
  html.includes(`data-tab="${slug}" aria-controls="panel-${slug}" aria-selected="true"`);

// A seção `sectionId` mora DENTRO do painel `panelSlug`? Assert por posição: o
// id da seção tem que aparecer depois da abertura do painel dela e antes da
// abertura do painel seguinte (ordem no DOM: agentes → integracoes →
// organizacao → sistema).
const PANEL_ORDER = ['agentes', 'integracoes', 'organizacao', 'sistema'];
function sectionInPanel(html: string, sectionId: string, panelSlug: string): boolean {
  const starts = PANEL_ORDER.map((p) => html.indexOf(`id="panel-${p}"`));
  if (starts.some((i) => i === -1)) return false;
  const idx = html.indexOf(`id="${sectionId}"`);
  if (idx === -1) return false;
  const pi = PANEL_ORDER.indexOf(panelSlug);
  const end = pi + 1 < PANEL_ORDER.length ? starts[pi + 1] : html.length;
  return idx > starts[pi] && idx < end;
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('4 abas', () => {
  it('nav tem agentes/integracoes/organizacao/sistema — e a antiga conexoes sumiu', async () => {
    const html = await fetchConfig();
    for (const slug of PANEL_ORDER) {
      expect(html).toContain(`id="config-tab-${slug}"`);
      expect(html).toContain(`id="panel-${slug}"`);
    }
    expect(html).not.toContain('data-tab="conexoes"');
    expect(html).not.toContain('id="panel-conexoes"');
  });

  it('aba default é Agentes', async () => {
    const html = await fetchConfig();
    expect(tabSelected(html, 'agentes')).toBe(true);
  });
});

describe('seções na aba certa', () => {
  it('#users e #api-keys moram em panel-agentes; #prefs e #owner-instructions também', async () => {
    const html = await fetchConfig();
    expect(sectionInPanel(html, 'users', 'agentes')).toBe(true);
    expect(sectionInPanel(html, 'api-keys', 'agentes')).toBe(true);
    expect(sectionInPanel(html, 'prefs', 'agentes')).toBe(true);
    expect(sectionInPanel(html, 'owner-instructions', 'agentes')).toBe(true);
  });

  it('as 4 integrações moram em panel-integracoes', async () => {
    const html = await fetchConfig();
    expect(sectionInPanel(html, 'google-contatos', 'integracoes')).toBe(true);
    expect(sectionInPanel(html, 'whatsapp-grupos', 'integracoes')).toBe(true);
    expect(sectionInPanel(html, 'instagram-contatos', 'integracoes')).toBe(true);
    expect(sectionInPanel(html, 'pipedrive-crm', 'integracoes')).toBe(true);
  });

  it('#board, #projects, #tags e #taxonomy seguem em panel-organizacao (sem #users)', async () => {
    const html = await fetchConfig();
    expect(sectionInPanel(html, 'board', 'organizacao')).toBe(true);
    expect(sectionInPanel(html, 'projects', 'organizacao')).toBe(true);
    expect(sectionInPanel(html, 'tags', 'organizacao')).toBe(true);
    expect(sectionInPanel(html, 'taxonomy', 'organizacao')).toBe(true);
    expect(sectionInPanel(html, 'users', 'organizacao')).toBe(false);
  });

  it('#backup segue em panel-sistema', async () => {
    const html = await fetchConfig();
    expect(sectionInPanel(html, 'backup', 'sistema')).toBe(true);
  });
});

describe('?saved= cai na aba certa no primeiro paint', () => {
  it('saved=users e saved=prefs → Agentes', async () => {
    expect(tabSelected(await fetchConfig('?saved=users'), 'agentes')).toBe(true);
    expect(tabSelected(await fetchConfig('?saved=prefs'), 'agentes')).toBe(true);
  });

  it('saved=board, saved=taxonomy e saved=tags → Organização (tags era o furo da tela antiga)', async () => {
    expect(tabSelected(await fetchConfig('?saved=board'), 'organizacao')).toBe(true);
    expect(tabSelected(await fetchConfig('?saved=taxonomy'), 'organizacao')).toBe(true);
    expect(tabSelected(await fetchConfig('?saved=tags'), 'organizacao')).toBe(true);
  });

  it('saved=backup → Sistema', async () => {
    expect(tabSelected(await fetchConfig('?saved=backup'), 'sistema')).toBe(true);
  });
});

describe('cards de integração', () => {
  it('os 4 details viram conn-card com tile e status dot (gc/wa/ig/pd)', async () => {
    const html = await fetchConfig();
    const panel = html.slice(html.indexOf('id="panel-integracoes"'), html.indexOf('id="panel-organizacao"'));
    expect(panel.split('conn-card').length - 1).toBeGreaterThanOrEqual(4);
    for (const dot of ['gc-dot', 'wa-dot', 'ig-dot', 'pd-dot']) {
      expect(panel).toContain(`id="${dot}"`);
    }
  });

  it('corpo das integrações fica intacto (IDs de hidratação preservados)', async () => {
    const html = await fetchConfig();
    for (const id of ['gc-status', 'wa-status', 'ig-status', 'pd-status', 'gc-connect', 'wa-save-groups', 'ig-save-contacts', 'pd-sync']) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});

describe('cards de agente', () => {
  it('usuário rende card com botão criar-chave apontando pro id dele', async () => {
    await createUser(E, { id: 'user_castro', name: 'Bruno Castro', type: 'agent', bio: null, api_key_id: null }, 1);
    const html = await fetchConfig();
    expect(html).toContain('data-create-key-for="user_castro"');
    expect(html).toContain('Bruno Castro');
  });

  it('usuário sem chave mostra status "Sem chave"; card é um details expansível', async () => {
    await createUser(E, { id: 'user_almeida', name: 'Ana Almeida', type: 'agent', bio: null, api_key_id: null }, 1);
    const html = await fetchConfig();
    const panel = html.slice(html.indexOf('id="panel-agentes"'), html.indexOf('id="panel-integracoes"'));
    expect(panel).toContain('agent-card');
    expect(panel).toContain('Sem chave');
  });
});

describe('bundle da config', () => {
  it('conhece as abas novas, o alias #conexoes e o prefill de criar-chave', () => {
    const js = configPageScript();
    expect(js).toContain('integracoes');
    expect(js).toContain('conexoes');
    expect(js).toContain('data-create-key-for');
  });
});
