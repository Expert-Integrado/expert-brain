import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// Pedido do dono: "a tela de contatos não consegue filtrar por grupos de
// WhatsApp" — <select> "Grupo" no overlay de /app/contacts, ausente em
// /app/graph (o vault de NOTAS do Brain não tem grupos de WhatsApp).

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

describe('filtro "Grupo" no overlay do grafo (pedido do dono)', () => {
  it('/app/contacts renderiza o <select> de grupo', async () => {
    const res = await SELF.fetch('https://x.test/app/contacts', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('id="graph-group-select"');
    expect(html).toContain('Todos os grupos');
  });

  it('/app/graph (vault de notas do Brain) NÃO ganha o select de grupo', async () => {
    const res = await SELF.fetch('https://x.test/app/graph', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).not.toContain('id="graph-group-select"');
  });
});
