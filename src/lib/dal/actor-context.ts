/**
 * An actor bound for the duration of one server-side task.
 *
 * The data access layer resolves the current user from the session cookie,
 * which is the right thing for a request and the wrong thing for a script. A
 * script has no browser and no cookie, so without this it would have to either
 * bypass the access layer entirely, or re-implement every function it needs in
 * raw SQL. Both are bad: the first skips the authorisation checks, and the
 * second drifts from the application the moment the schema or a rule changes.
 *
 * Instead a script can state who it is acting as, and then call the ordinary
 * data access functions. The demo world is therefore created by exactly the
 * code that serves the pages, so it cannot disagree with them.
 *
 * Two properties keep this from becoming a way to escalate privilege:
 *
 *  - It only applies to code that can reach this module, which means the
 *    server process: nothing here is bundled for a browser, and no request
 *    handler ever calls it.
 *  - It refuses to bind in production, so a deployment cannot be driven by a
 *    script-supplied identity even if one were somehow introduced.
 */

import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../env";
import { AppError } from "../api";
import type { Role } from "../auth/session";
import type { Actor } from "./access";

const storage = new AsyncLocalStorage<Actor>();

/** The actor bound to this task, if any. */
export function boundActor(): Actor | null {
  return storage.getStore() ?? null;
}

/**
 * Run a task as a given identity.
 *
 * The binding covers the callback and anything it awaits, so nested calls all
 * see the same actor. It does not leak: once the callback settles, the store
 * is gone, and a later task in the same process starts unbound.
 */
export async function withActor<T>(
  actor: Omit<Actor, "sessionId" | "expiresAt">,
  task: () => Promise<T>,
): Promise<T> {
  if (env.isProduction) {
    throw AppError.forbidden(
      "A script-supplied identity is not available in production.",
      "Scripts must sign in as a real user in a production deployment.",
    );
  }
  const bound: Actor = {
    ...actor,
    sessionId: "script",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  return storage.run(bound, task);
}

/** Narrow a role, for scripts that read it from configuration. */
export function asRole(value: string | undefined): Role {
  if (value === "admin" || value === "analyst" || value === "viewer") return value;
  throw new Error(
    `Unknown role ${String(value)}. Expected admin, analyst or viewer.`,
  );
}
