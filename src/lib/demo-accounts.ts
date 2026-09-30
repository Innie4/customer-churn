/**
 * The demo accounts offered on the sign-in page.
 *
 * This exists so the platform can be shown without typing a password, and it is
 * deliberately the weakest link in the security model, so it is fenced in as
 * narrowly as it can be:
 *
 *  - It is refused outright in production. Not "hidden" in production:
 *    refused, because a hidden endpoint is still an endpoint.
 *  - It requires simulated mode as well, so switching the flag on cannot by
 *    itself expose it.
 *  - It requires the shared demo password to be present. Absent that variable
 *    there is nothing to authenticate with, so the whole feature is off by
 *    default even in development.
 *  - It signs in only to the two accounts listed here, chosen by a fixed key.
 *    It does not accept an email address, so it cannot be pointed at any other
 *    user in the database, which is what would turn this into a way to become
 *    an administrator.
 *
 * The sign-in itself is the ordinary `signIn` call, so sessions, cookies,
 * lockout counters and the audit trail behave exactly as they do for a typed
 * password. A demo login is recorded in the audit trail like any other, which
 * is what keeps the demonstration honest: the audit page shows real entries
 * because real entries were written.
 */

import "server-only";

import { env } from "./env";
import { AppError } from "./api";
import { signIn, type UserSummary } from "./dal/users";
import { clientAddress, clientUserAgent } from "./audit";

export interface DemoAccount {
  /** Fixed identifier used by the request. Never an email address. */
  key: string;
  email: string;
  displayName: string;
  role: "admin" | "analyst" | "viewer";
  /** Shown on the button, so the visitor knows what the account can do. */
  summary: string;
}

/**
 * The accounts, in the order they are offered.
 *
 * Two is enough to demonstrate the role model: an administrator can reach
 * settings and team administration, an analyst cannot. Seeing the difference is
 * more useful than two accounts that behave identically.
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: "admin",
    email: "demo.admin@example.com",
    displayName: "Ada Okonjo",
    role: "admin",
    summary: "Full access, including settings and team administration.",
  },
  {
    key: "analyst",
    email: "demo.analyst@example.com",
    displayName: "Ravi Lindqvist",
    role: "analyst",
    summary: "Upload, train and activate models. No settings access.",
  },
];

export function demoAccountFor(key: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((account) => account.key === key);
}

/** The password both demo accounts share, or an empty string when unset. */
function demoPassword(): string {
  return process.env.DEMO_ACCOUNT_PASSWORD?.trim() ?? "";
}

/**
 * Whether the one-click accounts should be offered.
 *
 * The caller is the sign-in page, which needs to know this before it renders,
 * so the check is a plain function rather than something that throws.
 */
export function demoSignInAvailable(): boolean {
  if (env.isProduction) return false;
  if (!env.simulatedMode) return false;
  return demoPassword().length > 0;
}

/** The accounts safe to render on the page. */
export function availableDemoAccounts(): readonly DemoAccount[] {
  return demoSignInAvailable() ? DEMO_ACCOUNTS : [];
}

/**
 * Sign in as one of the demo accounts.
 *
 * Throws if the feature is unavailable or the key is not one of the listed
 * accounts, so a crafted request cannot reach a user who is not on this list.
 */
export async function signInAsDemoAccount(
  key: string,
  context: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<UserSummary> {
  if (env.isProduction) {
    throw AppError.forbidden(
      "Demo sign-in is not available in production.",
      "Sign in with your own account.",
    );
  }
  if (!demoSignInAvailable()) {
    throw AppError.notFound("That is not available on this deployment.");
  }

  const account = demoAccountFor(key);
  if (!account) {
    throw AppError.notFound("That is not one of the demo accounts.");
  }

  const password = demoPassword();
  const result = await signIn(account.email, password, {
    ipAddress: context.ipAddress ?? (await clientAddress()),
    userAgent: context.userAgent ?? (await clientUserAgent()),
  });
  return result.user;
}