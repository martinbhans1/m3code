import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Encoding for the stored remote-access password secret:
 *   [version:1][salt:SALT_BYTES][hash:HASH_BYTES]
 * The hash is scrypt(password, salt). Verification is constant-time.
 *
 * scrypt is intentionally slow; verification is only exercised on interactive
 * login (never per-request), so the synchronous variant is acceptable and its
 * single-threaded cost naturally serialises brute-force attempts.
 */
const VERSION = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;

const normalize = (password: string): string => password.normalize("NFKC");

export function hashAccessPassword(password: string): Uint8Array {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(normalize(password), salt, HASH_BYTES, SCRYPT_PARAMS);
  const encoded = new Uint8Array(1 + SALT_BYTES + HASH_BYTES);
  encoded[0] = VERSION;
  encoded.set(salt, 1);
  encoded.set(hash, 1 + SALT_BYTES);
  return encoded;
}

export function verifyAccessPasswordHash(password: string, stored: Uint8Array): boolean {
  if (stored.length !== 1 + SALT_BYTES + HASH_BYTES || stored[0] !== VERSION) {
    return false;
  }
  const salt = Buffer.from(stored.subarray(1, 1 + SALT_BYTES));
  const expected = Buffer.from(stored.subarray(1 + SALT_BYTES));
  let actual: Buffer;
  try {
    actual = scryptSync(normalize(password), salt, HASH_BYTES, SCRYPT_PARAMS);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
