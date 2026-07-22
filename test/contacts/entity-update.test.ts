import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';

// Spec 30-features/36 fase 3 — POST /app/entity/update (edição de contato pelo
// Console). Auth por SESSÃO (cookie mv_session), NUNCA Bearer. Reusa
// updateEntityFields/normalizeCategory/reembed do write-path REST.

const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

// POST autenticado por sessão. redirect:'manual' pra observar o 302 do
// requireSession (sem seguir pro login e virar 200 da página).
async function postSession(body: unknown, cookie: string) {
  return SELF.fetch('https://x/app/entity/update', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

async function seedPerson(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, phone, email, role, company, category, source)
     VALUES (?, 'person', ?, ?, ?, ?, ?, ?, 'seed')`,
  ).bind(
    id,
    (overrides.name as string) ?? 'Fulano Teste',
    (overrides.phone as string) ?? null,
    (overrides.email as string) ?? null,
    (overrides.role as string) ?? null,
    (overrides.company as string) ?? null,
    (overrides.category as string) ?? null,
  ).run();
  return id;
}

async function readEntity(id: string): Promise<any> {
  return env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<any>();
}

describe('POST /app/entity/update — auth de sessão', () => {
  it('sem cookie de sessão → 302 (redirect pro login), NUNCA aplica', async () => {
    const id = await seedPerson();
    const res = await postSession({ id, name: 'Hacker' }, '');
    // requireSession redireciona (302) quando não há cookie válido.
    expect(res.status).toBe(302);
    const after = await readEntity(id);
    expect(after.name).toBe('Fulano Teste'); // inalterado
  });

  it('cookie inválido → 302, não aplica', async () => {
    const id = await seedPerson();
    const res = await postSession({ id, name: 'Hacker' }, 'mv_session=lixo.invalido.xyz');
    expect(res.status).toBe(302);
    const after = await readEntity(id);
    expect(after.name).toBe('Fulano Teste');
  });
});

describe('POST /app/entity/update — caminho feliz', () => {
  it('edita nome, telefone e categoria de um contato → persiste', async () => {
    const cookie = await sessionCookie();
    const id = await seedPerson({ name: 'Nome Antigo', category: 'lead' });

    const res = await postSession(
      { id, name: 'Nome Novo', phone: '5511987654321', category: 'cliente', role: 'CEO' },
      cookie,
    );
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.id).toBe(id);
    expect(j.action).toBe('updated');
    expect(j.updated_at).toBeTruthy();

    const after = await readEntity(id);
    expect(after.name).toBe('Nome Novo');
    expect(after.phone).toBe('5511987654321');
    expect(after.category).toBe('cliente');
    expect(after.role).toBe('CEO');
  });

  it('campo ausente no body preserva o valor atual (COALESCE)', async () => {
    const cookie = await sessionCookie();
    const id = await seedPerson({ name: 'Preserva', email: 'antigo@ex.com', category: 'aluno' });
    // manda só o nome — email e category devem ficar intactos
    const res = await postSession({ id, name: 'Preserva Editado' }, cookie);
    expect(res.status).toBe(200);
    const after = await readEntity(id);
    expect(after.name).toBe('Preserva Editado');
    expect(after.email).toBe('antigo@ex.com');
    expect(after.category).toBe('aluno');
  });

  it('category "" (string vazia) normaliza p/ null → não sobrescreve categoria', async () => {
    const cookie = await sessionCookie();
    const id = await seedPerson({ category: 'network' });
    const res = await postSession({ id, category: '' }, cookie);
    expect(res.status).toBe(200);
    const after = await readEntity(id);
    // "" normaliza p/ null → COALESCE mantém a categoria existente (mesma regra do REST)
    expect(after.category).toBe('network');
  });
});

describe('POST /app/entity/update — validação', () => {
  it('id ausente → 400', async () => {
    const cookie = await sessionCookie();
    const res = await postSession({ name: 'Sem id' }, cookie);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toBe('id required');
  });

  it('categoria inválida → 400 com allowed (MESMO enum do REST)', async () => {
    const cookie = await sessionCookie();
    const id = await seedPerson();
    const res = await postSession({ id, category: 'inexistente' }, cookie);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toContain('invalid category');
    expect(j.allowed).toContain('cliente');
    // não aplicou nada
    const after = await readEntity(id);
    expect(after.category).toBeNull();
  });

  it('id inexistente → 404', async () => {
    const cookie = await sessionCookie();
    const res = await postSession({ id: crypto.randomUUID(), name: 'Fantasma' }, cookie);
    expect(res.status).toBe(404);
    const j: any = await res.json();
    expect(j.error).toBe('entity_not_found');
  });

  it('json inválido → 400', async () => {
    const cookie = await sessionCookie();
    const res = await SELF.fetch('https://x/app/entity/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{ nao é json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /app/entity/update — concorrência otimista', () => {
  it('expected_updated_at desatualizado → 409, sem sobrescrever', async () => {
    const cookie = await sessionCookie();
    const id = await seedPerson({ name: 'Concorrente' });

    // simula edição concorrente do agente: muda a linha (dispara o trigger updated_at)
    await env.DB.prepare("UPDATE entities SET role = 'mexido pelo agente' WHERE id = ?").bind(id).run();

    // a UI tenta salvar com um updated_at ANTIGO (stale)
    const res = await postSession(
      { id, name: 'Sobrescrita', expected_updated_at: '2000-01-01 00:00:00' },
      cookie,
    );
    expect(res.status).toBe(409);
    const j: any = await res.json();
    expect(j.error).toBe('conflict');
    expect(j.updated_at).toBeTruthy();

    // nome NÃO foi sobrescrito
    const after = await readEntity(id);
    expect(after.name).toBe('Concorrente');
    expect(after.role).toBe('mexido pelo agente');
  });

  it('expected_updated_at correto → 200 e aplica', async () => {
    const cookie = await sessionCookie();
    const id = await seedPerson({ name: 'Token OK' });
    const current = await readEntity(id);

    const res = await postSession(
      { id, name: 'Token OK Editado', expected_updated_at: current.updated_at },
      cookie,
    );
    expect(res.status).toBe(200);
    const after = await readEntity(id);
    expect(after.name).toBe('Token OK Editado');
  });
});
