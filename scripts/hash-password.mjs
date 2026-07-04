#!/usr/bin/env node
// Hash a passphrase with the exact same format the Worker uses.
// Format: pbkdf2$sha256$100000$<saltBase64>$<hashBase64>
// Usage: node scripts/hash-password.mjs "<passphrase>"
//
// The 100k iteration count matches Cloudflare Workers' hard cap on PBKDF2
// (see src/auth/password.ts). Below OWASP 2023 guidance (600k) but acceptable
// for a single-user vault where the attack surface is the owner's own passphrase.

import { pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 100_000;
const HASH_LEN = 32;
const SALT_LEN = 16;

const passphrase = process.argv[2];
if (!passphrase) {
  console.error('Usage: node scripts/hash-password.mjs "<passphrase>"');
  process.exit(1);
}

const salt = randomBytes(SALT_LEN);
const hash = pbkdf2Sync(passphrase, salt, ITERATIONS, HASH_LEN, 'sha256');

process.stdout.write(
  `pbkdf2$sha256$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}\n`
);
