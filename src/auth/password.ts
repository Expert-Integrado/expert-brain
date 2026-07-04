// PBKDF2-SHA-256 via WebCrypto nativo do Workers runtime.
// Hash-wasm (argon2id) não funciona em produção — Workers bloqueia WebAssembly.compile() dinâmico.
// Cloudflare Workers cap PBKDF2 em 100_000 iterations (hard limit). Abaixo do target OWASP 2023
// (600k), mas aceitável pra single-user vault onde a superfície de ataque é a passphrase do
// próprio dono — não temos brute force de atacante externo com millions of hashes.
// Formato do hash armazenado: pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>

const ITERATIONS = 100_000;
const HASH_LEN = 32;
const SALT_LEN = 16;

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    HASH_LEN * 8
  );
  return new Uint8Array(bits);
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hash = await deriveKey(plain, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 5) return false;
    const [scheme, algo, iterStr, saltB64, hashB64] = parts;
    if (scheme !== 'pbkdf2' || algo !== 'sha256') return false;
    const iterations = parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;
    const salt = b64decode(saltB64);
    const expected = b64decode(hashB64);
    const actual = await deriveKey(plain, salt, iterations);
    if (actual.length !== expected.length) return false;
    // Constant-time comparison
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}
