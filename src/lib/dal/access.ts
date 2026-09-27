/**
 * Access control for the data access layer.
 *
 * Every read and write in the application goes through a function in this
 * directory, and every one of those functions resolves the current session and
 * checks a capability before touching the database. Authorisation is therefore
 * not something a route handler can forget.
 */

import "server-only";

import { AppError } from "../api";
import {
  canActivateModels,
  canAdminister,
  canCreateActions,
  canManageModels,
  canUpload,
  getSession,
  type Role,
} from "../auth/session";

export interface Actor {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  sessionId: string;
  expiresAt: string;
}

/**
 * Resolve the current actor, or throw 401.
 *
 * Use this in any function that must not run for an anonymous visitor. Reading
 * a session is cheap and cached per request by the framework.
 */
export async function requireActor(): Promise<Actor> {
  const session = await getSession();
  if (!session) {
    throw AppError.unauthorized(
      "Your session has ended or was never established.",
      "Sign in to continue.",
    );
  }
  return session;
}

/** Resolve the current actor, or null. For pages that render either way. */
export async function currentActor(): Promise<Actor | null> {
  const session = await getSession();
  if (!session) return null;
  return {
    id: session.id,
    email: session.email,
    fullName: session.fullName,
    role: session.role,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
  };
}

export async function requireCapability(
  capability: Capability,
): Promise<Actor> {
  const actor = await requireActor();
  assertCapability(actor.role, capability);
  return actor;
}

export type Capability =
  | "read"
  | "upload"
  | "manageModels"
  | "activateModels"
  | "createActions"
  | "administer";

const DENIAL: Record<Capability, string> = {
  read: "Your role does not allow viewing this data.",
  upload: "Your role does not allow uploading datasets.",
  manageModels: "Your role does not allow training or editing models.",
  activateModels: "Your role does not allow activating a model.",
  createActions: "Your role does not allow creating retention actions.",
  administer: "This action is restricted to administrators.",
};

export function assertCapability(role: Role, capability: Capability): void {
  const allowed: Record<Capability, boolean> = {
    read: true,
    upload: canUpload(role),
    manageModels: canManageModels(role),
    activateModels: canActivateModels(role),
    createActions: canCreateActions(role),
    administer: canAdminister(role),
  };
  if (allowed[capability]) return;
  throw AppError.forbidden(
    DENIAL[capability],
    "Ask an administrator if you need this access.",
  );
}

/** Narrow a possibly-null actor for a capability, throwing when insufficient. */
export function assertCan(
  actor: Actor | null,
  capability: Capability,
): asserts actor is Actor {
  if (!actor) {
    throw AppError.unauthorized(
      "You need to sign in to see this.",
      "Sign in and try again.",
    );
  }
  assertCapability(actor.role, capability);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  analyst: "Analyst",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full access, including user management and model activation.",
  analyst: "Can upload data, train models, activate them and manage retention work.",
  viewer: "Read-only access to data, models, predictions and reports.",
};
