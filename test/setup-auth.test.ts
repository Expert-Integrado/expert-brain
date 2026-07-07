import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { authHandler } from '../src/auth/handler';
import { handleProvision, handleBackfillSimilar } from '../src/auth/setup';
import { signSession } from '../src/web/session';
import { registerLoginFailure, checkLoginAllowed, clearLoginFailures } from '../src/auth/rate-limit';

// Spec 10-backend/18: gate dos /setup/* + rate limit de login.
// SELF serve o worker do console (src/web/worker.ts) — /authorize e /setup/*
// não são roteados lá, então esses vão direto no authHandler/handlers.

const E = env as any;

function authorizePost(fields: Record<string, string>, ip: string): Request {
  return new Request('https://example.com/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function appLoginPost(fields: Record<string, string>, ip: string): Request {
  return new Request('https://example.com/app/login', {
    method: 'POST',
    headers: {
      origin: 'https://example.com',
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip,
    },
    body: new URLSearchParams({ next: '/app/graph', ...fields }).toString(),
  });
}

const setupPost = (path: string, bearer?: string) =>
  new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

beforeAll(async () => {
  // Garante o schema (idempotente) — o backfill lê a tabela notes.
  const res = await handleProvision(setupPost('/setup/provision', 'setup-tok'), E);
  expect(res.status).toBe(200);
});

describe('gate dos /setup/* (spec 10-backend/18)', () => {
  it('provision SEM credencial em vault configurado => 401', async () => {
    const res = await handleProvision(setupPost('/setup/provision'), E);
    expect(res.status).toBe(401);
  });

  it('provision SEM credencial em vault NAO configurado => aberto (bootstrap)', async () => {
    const bare = { ...E, OWNER_EMAIL: undefined, OWNER_PASSWORD_HASH: undefined, SESSION_SECRET: undefined };
    const res = await handleProvision(setupPost('/setup/provision'), bare);
    expect(res.status).toBe(200);
  });

  it('provision com Bearer SETUP_TOKEN => 200', async () => {
    const res = await handleProvision(setupPost('/setup/provision', 'setup-tok'), E);
    expect(res.status).toBe(200);
  });

  it('backfill-similar SEM credencial => 401; Bearer errado => 401', async () => {
    expect((await handleBackfillSimilar(setupPost('/setup/backfill-similar'), E)).status).toBe(401);
    expect((await handleBackfillSimilar(setupPost('/setup/backfill-similar', 'nope'), E)).status).toBe(401);
  });

  it('backfill-similar com Bearer GRAPH_EXPORT_TOKEN => 200', async () => {
    const res = await handleBackfillSimilar(setupPost('/setup/backfill-similar', 'tok'), E);
    expect(res.status).toBe(200);
  });

  it('backfill-similar com cookie de sessao valido => 200', async () => {
    const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
    const req = new Request('https://example.com/setup/backfill-similar', {
      method: 'POST',
      headers: { cookie: `eb_session=${token}` },
    });
    const res = await handleBackfillSimilar(req, E);
    expect(res.status).toBe(200);
  });
});

describe('rate limit de login (spec 10-backend/18)', () => {
  it('/authorize: 6 falhas de senha => 7a tentativa 429 + retry-after', async () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 6; i++) {
      const res = await authHandler.fetch(
        authorizePost({ email: E.OWNER_EMAIL, password: 'senha-errada' }, ip), E, {} as any);
      expect(res.status).toBe(200); // renderLogin de erro
    }
    // 7a tentativa: bloqueada antes do PBKDF2.
    const blocked = await authHandler.fetch(
      authorizePost({ email: E.OWNER_EMAIL, password: 'correct-horse-battery-staple' }, ip), E, {} as any);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('e-mail errado tambem conta falha (nao vira oraculo gratis)', async () => {
    const ip = '10.0.0.5';
    for (let i = 0; i < 6; i++) {
      const res = await authHandler.fetch(
        authorizePost({ email: 'intruso@example.com', password: 'x' }, ip), E, {} as any);
      expect(res.status).toBe(200);
    }
    const blocked = await authHandler.fetch(
      authorizePost({ email: 'intruso@example.com', password: 'x' }, ip), E, {} as any);
    expect(blocked.status).toBe(429);
  });

  it('/app/login compartilha o bucket: falhas la somam com /authorize', async () => {
    const ip = '10.0.0.2';
    for (let i = 0; i < 6; i++) {
      await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: 'senha-errada' }, ip));
    }
    // Bloqueio vale nos DOIS endpoints (mesma chave IP+e-mail).
    const viaApp = await SELF.fetch(appLoginPost({ email: E.OWNER_EMAIL, password: 'senha-errada' }, ip));
    expect(viaApp.status).toBe(429);
    expect(Number(viaApp.headers.get('retry-after'))).toBeGreaterThan(0);
    const viaAuthorize = await authHandler.fetch(
      authorizePost({ email: E.OWNER_EMAIL, password: 'correct-horse-battery-staple' }, ip), E, {} as any);
    expect(viaAuthorize.status).toBe(429);
  });

  it('login com sucesso limpa o contador', async () => {
    const ip = '10.0.0.3';
    const provider = {
      parseAuthRequest: async () => ({ scope: ['mcp'] }),
      completeAuthorization: async () => ({ redirectTo: 'https://example.com/cb' }),
    };
    const envWithProvider = { ...E, OAUTH_PROVIDER: provider };
    for (let i = 0; i < 3; i++) {
      await authHandler.fetch(
        authorizePost({ email: E.OWNER_EMAIL, password: 'senha-errada' }, ip), envWithProvider, {} as any);
    }
    const ok = await authHandler.fetch(
      authorizePost({ email: E.OWNER_EMAIL, password: 'correct-horse-battery-staple' }, ip),
      envWithProvider, {} as any);
    expect(ok.status).toBe(302);
    // Bucket zerado: nenhuma chave rl:login deste IP sobra no KV.
    const keys = await E.OAUTH_KV.list({ prefix: `rl:login:${ip}:` });
    expect(keys.keys.length).toBe(0);
  });

  it('funcoes de bucket: bloqueio exponencial e clear', async () => {
    const ip = '10.0.0.4';
    const email = 'alvo@example.com';
    for (let i = 0; i < 6; i++) await registerLoginFailure(E, ip, email);
    const gate = await checkLoginAllowed(E, ip, email);
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterS).toBeGreaterThan(0);
    await clearLoginFailures(E, ip, email);
    expect((await checkLoginAllowed(E, ip, email)).allowed).toBe(true);
  });
});
