import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';

// Spec 20-frontend/24 parte A — GET /app/media/:hash atrás da SESSÃO, espelho da
// rota Bearer GET /media/:hash. O <img> do painel não manda Bearer e o cookie tem
// Path=/app, então a rota da API sempre respondia 401 pro browser.

const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

// sha256 de conteúdo fake — só precisa ser um hex de 64 chars estável.
const HASH = 'a'.repeat(64);

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

function get(path: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return SELF.fetch(`https://x${path}`, { headers, redirect: 'manual' });
}

beforeAll(async () => {
  await E.MEDIA.put(`sha256/${HASH}.png`, new Uint8Array([137, 80, 78, 71]), {
    httpMetadata: { contentType: 'image/png' },
  });
});

describe('GET /app/media/:hash (spec 20-frontend/24)', () => {
  it('com sessão => 200 com content-type de imagem', async () => {
    const res = await get(`/app/media/${HASH}`, await sessionCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('sem sessão => 302 pro login (não vira rota pública)', async () => {
    const res = await get(`/app/media/${HASH}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/app/login');
  });

  it('hash desconhecido com sessão => 404', async () => {
    const res = await get(`/app/media/${'b'.repeat(64)}`, await sessionCookie());
    expect(res.status).toBe(404);
  });

  it('hash fora do formato (não 64-hex) => 404 de rota, não 500', async () => {
    const res = await get('/app/media/nao-e-hash', await sessionCookie());
    expect(res.status).toBe(404);
  });

  it('rota antiga GET /media/:hash segue exigindo Bearer (401 sem)', async () => {
    const res = await SELF.fetch(`https://x/media/${HASH}`);
    expect(res.status).toBe(401);
  });

  it('rota antiga com Bearer OWNER_TOKEN segue 200', async () => {
    const res = await SELF.fetch(`https://x/media/${HASH}`, {
      headers: { authorization: `Bearer ${E.OWNER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});
