import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { configPageScript } from '../src/web/config-script.js';

// Painel "Google Contatos" em /app/config#google-contatos (expert-contacts
// specs/google-contacts-sync.md). Mesmo padrão do contacts-entity-event-proxy:
// o service binding CONTACTS não existe neste ambiente de teste, então cobrimos
// o gate de sessão e a degradação graciosa (503) dos proxies.

const E = env as any;

beforeAll(async () => {
  await runMigrations(E);
});

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

describe('painel Google Contatos na config', () => {
  it('a aba Conexões carrega a seção #google-contatos com botões e área de etiquetas', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="google-contatos"');
    expect(html).toContain('id="gc-connect"');
    expect(html).toContain('id="gc-sync"');
    expect(html).toContain('id="gc-labels-section"');
    expect(html).toContain('id="gc-labels-all"');
    expect(html).toContain('id="gc-labels-none"');
    // microcopy que fixa o contrato: pull não altera a agenda; a volta é opt-in
    expect(html).toContain('Por padrão nada é alterado na sua agenda');
  });

  it('seção do write-back: toggle default OFF, status e botão de reautorização', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    const html = await res.text();
    expect(html).toContain('id="gc-writeback-section"');
    expect(html).toContain('id="gc-write-back"');
    expect(html).toContain('id="gc-writeback-status"');
    expect(html).toContain('id="gc-reauth"');
    // contrato na copy: só identidade sai; dossiê nunca; criação não
    expect(html).toContain('dossiê, observações e categorias nunca vão pro Google');
    // a seção e o botão nascem escondidos (só aparecem conectado / precisando reautorizar)
    expect(html).toMatch(/id="gc-writeback-section" hidden/);
    expect(html).toMatch(/id="gc-reauth" hidden/);
  });

  it('wizard de configuração pela tela: passos com deep links, URI de copiar e campos de credencial', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    const html = await res.text();
    expect(html).toContain('id="gc-setup"');
    expect(html).toContain('id="gc-callback-uri"');
    expect(html).toContain('data-copy="gc-callback-uri"');
    // atalho pro assistente de IA: botão copia a instrução montada em runtime
    expect(html).toContain('data-copy="gc-agent-prompt"');
    expect(html).toContain('id="gc-agent-prompt"');
    expect(html).toContain('id="gc-client-id"');
    expect(html).toContain('id="gc-client-secret"');
    expect(html).toContain('id="gc-save-client"');
    expect(html).toContain('id="gc-creds-row"');
    // deep links pro console do Google — os 4 passos que acontecem lá
    expect(html).toContain('console.cloud.google.com/projectcreate');
    expect(html).toContain('console.cloud.google.com/apis/library/people.googleapis.com');
    expect(html).toContain('console.cloud.google.com/auth/clients/create');
    expect(html).toContain('console.cloud.google.com/auth/audience');
    // a chave secreta entra em campo de senha (nunca visível na tela)
    expect(html).toContain('type="password" id="gc-client-secret"');
    // avisos que evitam os 2 tropeços clássicos: app não publicado e tela de não verificado
    expect(html).toContain('Publicar app');
    expect(html).toContain('app não verificado');
  });

  it('bundle da config é JS sintaticamente válido (parse real, não só containment)', () => {
    // Regressão do incidente 18/07: config-script.ts é um TEMPLATE LITERAL — um
    // '\n' sem escape dobrado vira quebra de linha REAL no JS servido e mata o
    // script da página inteira (abas, ícones, copiar). Containment não pega isso;
    // new Function() parseia o código sem executar.
    expect(() => new Function(configPageScript())).not.toThrow();
  });

  it('bundle da config carrega o wiring do painel (inclusive a rota de credencial)', async () => {
    const res = await SELF.fetch('https://x.test/app/config/bundle.js');
    const js = await res.text();
    expect(js).toContain('/app/config/google/status');
    expect(js).toContain('/app/config/google/client');
    expect(js).toContain('/app/config/google/write-back');
    expect(js).toContain('gc-callback-uri');
    expect(js).toContain('google-contatos');
  });

  it('copy 100% leiga: zero jargão de servidor no painel e no bundle', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { headers: { cookie: await cookie() } });
    const html = await res.text();
    const bundle = await (await SELF.fetch('https://x.test/app/config/bundle.js')).text();
    for (const jargon of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'wrangler secret']) {
      expect(html, `html não pode conter ${jargon}`).not.toContain(jargon);
      expect(bundle, `bundle não pode conter ${jargon}`).not.toContain(jargon);
    }
  });
});

describe('proxies /app/config/google/* — gate de sessão + degradação graciosa', () => {
  const gets = ['/app/config/google/status', '/app/config/google/labels'];
  const posts = ['/app/config/google/connect', '/app/config/google/config', '/app/config/google/client', '/app/config/google/sync', '/app/config/google/disconnect', '/app/config/google/write-back'];

  it('sem sessão → 302 (GET) / bloqueado (POST), nunca tenta o binding', async () => {
    for (const p of gets) {
      const res = await SELF.fetch(`https://x.test${p}`, { redirect: 'manual' });
      expect(res.status, p).toBe(302);
    }
    for (const p of posts) {
      const res = await SELF.fetch(`https://x.test${p}`, { method: 'POST', redirect: 'manual' });
      expect([302, 401], p).toContain(res.status);
    }
  });

  it('com sessão mas sem binding CONTACTS configurado → 503 em todos', async () => {
    const ck = await cookie();
    for (const p of gets) {
      const res = await SELF.fetch(`https://x.test${p}`, { headers: { cookie: ck } });
      expect(res.status, p).toBe(503);
    }
    for (const p of posts) {
      const res = await SELF.fetch(`https://x.test${p}`, { method: 'POST', headers: { cookie: ck }, body: '{}' });
      expect(res.status, p).toBe(503);
    }
  });
});
