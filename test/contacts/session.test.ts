import { describe, it, expect } from 'vitest';
import { signSession, verifySession } from '../../src/contacts/web/session';

// Sessão HMAC do Console (TTL 7 dias).
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const TTL = 7 * 24 * 60 * 60;

describe('signSession + verifySession', () => {
  it('round-trip devolve { email, issuedAt }', async () => {
    const issuedAt = 1_700_000_000;
    const token = await signSession('owner@example.com', SECRET, issuedAt);
    const v = await verifySession(token, SECRET, issuedAt + 10);
    expect(v).toEqual({ email: 'owner@example.com', issuedAt });
  });

  it('assinatura adulterada => null', async () => {
    const issuedAt = 1_700_000_000;
    const token = await signSession('owner@example.com', SECRET, issuedAt);
    const parts = token.split('.');
    // corrompe o último caractere da assinatura
    const sig = parts[2];
    const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
    expect(await verifySession(tampered, SECRET, issuedAt + 10)).toBeNull();
  });

  it('issuedAt além do TTL (7 dias) => null', async () => {
    const issuedAt = 1_700_000_000;
    const token = await signSession('owner@example.com', SECRET, issuedAt);
    expect(await verifySession(token, SECRET, issuedAt + TTL + 1)).toBeNull();
  });

  it('exatamente no limite do TTL => ainda válido', async () => {
    const issuedAt = 1_700_000_000;
    const token = await signSession('owner@example.com', SECRET, issuedAt);
    const v = await verifySession(token, SECRET, issuedAt + TTL);
    expect(v).not.toBeNull();
  });

  it('formato inválido (≠ 3 partes) => null', async () => {
    expect(await verifySession('a.b', SECRET, 1_700_000_000)).toBeNull();
    expect(await verifySession('a.b.c.d', SECRET, 1_700_000_000)).toBeNull();
    expect(await verifySession('', SECRET, 1_700_000_000)).toBeNull();
  });

  it('secret diferente => null', async () => {
    const issuedAt = 1_700_000_000;
    const token = await signSession('owner@example.com', SECRET, issuedAt);
    expect(await verifySession(token, 'outro-secret-totalmente-diferente-xyz', issuedAt + 10)).toBeNull();
  });
});
