/**
 * Password and token hashing primitives.
 *
 * Deliberately free of any `server-only` import so that offline tools — the
 * migration runner, the seed script, the test suite — can hash a credential
 * through exactly the same code the application uses. There is one
 * implementation of the scrypt parameters, and no chance of a script hashing
 * something differently from the way the application verifies it.
 *
 * Nothing here reads environment variables or touches the database; the
 * application-level policy lives in `password.ts`.
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Cost parameters.
 *
 * N=2^15 with r=8 needs about 32 MB per hash, which is a deliberate cost for an
 * attacker and a tolerable one for a login. maxmem is raised above the default
 * because Node's default of 32 MB is not enough headroom for these parameters.
 */
const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAXMEM = 128 * 1024 * 1024;

/**
 * Hash a password.
 *
 * The stored format is self-describing:
 *   scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
 * so the cost parameters travel with the hash and can be raised later without
 * invalidating existing passwords.
 *
 * Call `checkPasswordPolicy` first if the value came from a person; this
 * function only performs the key derivation.
 */
export async function derivePasswordHash(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed hash rather than throwing, so a corrupted row
 * cannot turn into a crash on the login path. Comparison is constant time.
 */
export async function verifyPasswordHash(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  // Guard against a hostile stored value asking for an enormous allocation.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** SHA-256 digest, hex encoded. Used for session and reset token lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A fresh, unguessable token for a session or a password reset. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
