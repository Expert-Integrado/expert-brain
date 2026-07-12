// TOTP (RFC 6238) sobre HOTP/HMAC-SHA1 (RFC 4226) em WebCrypto puro, zero deps.
// SHA-1 aqui e HMAC (nao resistencia a colisao) e e o unico algoritmo que TODOS
// os apps autenticadores aceitam (Google Authenticator, 1Password, Authy).

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=]+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`invalid base32 character: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Secret novo de 160 bits (tamanho recomendado pela RFC 4226 para SHA-1). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hotp(key: Uint8Array, counter: bigint, digits: number): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, counter);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export async function totpCode(secretB32: string, timeMs: number, digits = 6): Promise<string> {
  const counter = BigInt(Math.floor(timeMs / 1000 / STEP_SECONDS));
  return hotp(base32Decode(secretB32), counter, digits);
}

/** Confere um codigo com janela de +-1 step (30s de relogio torto pra cada lado). */
export async function verifyTotp(
  secretB32: string,
  code: string,
  timeMs: number,
  digits = 6,
): Promise<boolean> {
  const clean = code.replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return false;
  const key = base32Decode(secretB32);
  const counter = BigInt(Math.floor(timeMs / 1000 / STEP_SECONDS));
  for (const delta of [0n, -1n, 1n]) {
    if ((await hotp(key, counter + delta, digits)) === clean) return true;
  }
  return false;
}

/** Link otpauth:// que apps autenticadores importam direto (sem QR na v1). */
export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${secretB32}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
