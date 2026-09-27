/**
 * Password policy and hashing, as the application uses them.
 *
 * `import "server-only"` is kept here because this module is what the sign-in
 * and password-reset paths use. The two pieces it is built from are free of that
 * marker so offline tooling can hash and validate through the same code:
 *
 *   policy.ts  the rules
 *   crypto.ts  the scrypt primitives
 *
 * Having one definition of each is the point: a script cannot hash a credential
 * differently from the way the application verifies it.
 */

import "server-only";

import {
  derivePasswordHash,
  verifyPasswordHash,
  hashToken,
  generateToken,
} from "./crypto";
import {
  checkPasswordPolicy,
  PasswordPolicyError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "./policy";

/** Check the policy, then derive a scrypt hash. */
export async function hashPassword(password: string): Promise<string> {
  checkPasswordPolicy(password);
  return derivePasswordHash(password);
}

export {
  checkPasswordPolicy,
  PasswordPolicyError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  hashToken,
  generateToken,
};
export { verifyPasswordHash as verifyPassword };
