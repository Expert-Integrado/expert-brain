import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// Pedido do dono (rodada de otimização visual, 11/07): "tem muitos contatos, as
// bolinhas ficam muito acumuladas". Duas mudanças de SSR fixadas aqui:
// 1. "Esconder isoladas" nasce LIGADO no vault de contatos (a maioria dos ~6,5k
//    contatos importados não tem nenhuma ligação — visíveis por padrão, viram
//    o amontoado da reclamação). No grafo de NOTAS o default continua desligado.
// 2. O select "Grupo" virou FILTRO de verdade (esconde quem não é membro), e a
//    microcopy do overlay reflete isso.
// O comportamento client (esconder de fato, limpar, reset) vive no bundle e é
// exercitado manualmente/e2e; aqui fixamos o contrato do HTML servido.

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

describe('declutter do grafo de contatos (SSR)', () => {
  it('/app/contacts nasce com "Esconder isoladas" LIGADO', async () => {
    const res = await SELF.fetch('https://x.test/app/contacts', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('id="hide-orphans" checked');
  });

  it('/app/graph (notas) mantém "Esconder isoladas" DESLIGADO por padrão', async () => {
    const res = await SELF.fetch('https://x.test/app/graph', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('id="hide-orphans"');
    expect(html).not.toContain('id="hide-orphans" checked');
  });

  it('microcopy do select "Grupo" descreve o filtro (não só o foco de câmera)', async () => {
    const res = await SELF.fetch('https://x.test/app/contacts', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('Mostra só o grupo escolhido e seus membros');
  });
});
