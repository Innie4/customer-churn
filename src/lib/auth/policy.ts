/**
 * Password policy.
 *
 * Pure rules with no I/O and no `server-only` marker, so the sign-up path, the
 * password-reset path and offline tooling all enforce one definition of an
 * acceptable password.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

/** Check a password against the platform policy without hashing it. */
export function checkPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
  if (!/[a-z]/.test(password)) {
    throw new PasswordPolicyError("Password must include a lowercase letter.");
  }
  if (!/[A-Z]/.test(password)) {
    throw new PasswordPolicyError("Password must include an uppercase letter.");
  }
  if (!/[0-9]/.test(password)) {
    throw new PasswordPolicyError("Password must include a digit.");
  }
}

/**
 * A short, non-prescriptive description of what is missing.
 *
 * Deliberately says which rule failed rather than listing the rules, so it can
 * be shown to a person without turning into a specification for a weak password.
 */
export function describePolicyFailure(password: string): string {
  try {
    checkPasswordPolicy(password);
    return "meets the policy";
  } catch (error) {
    return error instanceof Error ? error.message : "does not meet the policy";
  }
}
