import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  otpauthUri,
} from '../src/auth/totp.js';

// Secret dos vetores oficiais: ASCII "12345678901234567890" (RFC 6238 Appendix B).
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('encodes the RFC test secret', () => {
    const ascii = new TextEncoder().encode('12345678901234567890');
    expect(base32Encode(ascii)).toBe(RFC_SECRET_B32);
  });

  it('roundtrips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 7, 63, 99, 200]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('decodes ignoring case, spaces and padding', () => {
    const ascii = new TextEncoder().encode('12345678901234567890');
    expect(base32Decode('gezd gnbv gy3t qojq GEZD GNBV GY3T QOJQ====')).toEqual(ascii);
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('GEZ1')).toThrow(); // '1' fora do alfabeto RFC 4648
  });
});

describe('totpCode — vetores RFC 6238 (SHA-1, 8 digitos)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, expected] of vectors) {
    it(`T=${t} -> ${expected}`, async () => {
      expect(await totpCode(RFC_SECRET_B32, t * 1000, 8)).toBe(expected);
    });
  }

  it('defaults to 6 digits (sufixo do vetor de 8)', async () => {
    expect(await totpCode(RFC_SECRET_B32, 59_000)).toBe('287082');
  });
});

describe('verifyTotp', () => {
  const NOW = 1111111111_000; // dentro do step 37037037

  it('accepts the current code', async () => {
    const code = await totpCode(RFC_SECRET_B32, NOW);
    expect(await verifyTotp(RFC_SECRET_B32, code, NOW)).toBe(true);
  });

  it('accepts +-1 step (clock drift de 30s)', async () => {
    const prev = await totpCode(RFC_SECRET_B32, NOW - 30_000);
    const next = await totpCode(RFC_SECRET_B32, NOW + 30_000);
    expect(await verifyTotp(RFC_SECRET_B32, prev, NOW)).toBe(true);
    expect(await verifyTotp(RFC_SECRET_B32, next, NOW)).toBe(true);
  });

  it('rejects codes 2+ steps away', async () => {
    const stale = await totpCode(RFC_SECRET_B32, NOW - 60_000);
    const ahead = await totpCode(RFC_SECRET_B32, NOW + 60_000);
    // Colisao de 6 digitos entre steps e possivel em teoria, mas nao nestes vetores.
    expect(await verifyTotp(RFC_SECRET_B32, stale, NOW)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, ahead, NOW)).toBe(false);
  });

  it('tolerates surrounding whitespace and inner space', async () => {
    const code = await totpCode(RFC_SECRET_B32, NOW);
    const spaced = ` ${code.slice(0, 3)} ${code.slice(3)} `;
    expect(await verifyTotp(RFC_SECRET_B32, spaced, NOW)).toBe(true);
  });

  it('rejects malformed input without throwing', async () => {
    expect(await verifyTotp(RFC_SECRET_B32, '', NOW)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, '12345', NOW)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, 'abcdef', NOW)).toBe(false);
    expect(await verifyTotp(RFC_SECRET_B32, '1234567', NOW)).toBe(false);
  });
});

describe('generateTotpSecret', () => {
  it('emits 160 bits as 32 chars base32, unique per call', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a).length).toBe(20);
    expect(a).not.toBe(b);
  });
});

describe('otpauthUri', () => {
  it('builds a scannable uri with issuer and account escaped', () => {
    const uri = otpauthUri(RFC_SECRET_B32, 'contato@expertintegrado.com.br', 'Expert Brain');
    expect(uri).toBe(
      'otpauth://totp/Expert%20Brain:contato%40expertintegrado.com.br' +
        `?secret=${RFC_SECRET_B32}&issuer=Expert%20Brain&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
