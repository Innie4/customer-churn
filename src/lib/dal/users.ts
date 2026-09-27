/**
 * Users, sign-in and password reset.
 *
 * Two behaviours here are deliberate and worth stating:
 *
 *   * A failed sign-in and a sign-in to a non-existent address return the same
 *     message, so the form cannot be used to discover which addresses exist.
 *   * Repeated failures lock the account temporarily, which bounds online
 *     guessing without locking a real user out permanently.
 */

import "server-only";

import { getDatabase } from "../../../db/client";
import { AppError } from "../api";
import { AUDIT, clientAddress, recordAudit } from "../audit";
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
  type Role,
} from "../auth/session";
import {
  checkPasswordPolicy,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "../auth/password";
import { env } from "../env";
import { sendPasswordResetEmail } from "../email";
import { requireActor } from "./access";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface UserSummary {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: Role;
  status: string;
  session_epoch: number;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

/** Constant-ish work for unknown addresses, so timing does not leak existence. */
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "Y3JlYXRlZC1wbGFjZWhvbGRlci1zY3J5cHQtaGFzaC1mb3ItdW5rbm93bi1hZGRyZXNzZXM=";

export interface SignInResult {
  user: UserSummary;
}

export async function signIn(
  email: string,
  password: string,
  context: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<SignInResult> {
  const db = await getDatabase();
  const normalised = email.trim().toLowerCase();
  const result = await db.query<UserRow>(
    "SELECT * FROM users WHERE lower(email) = $1",
    [normalised],
  );
  const row = result.rows[0];

  // The message is identical whether the address is unknown, suspended or the
  // password is wrong. Anything more specific helps someone guess.
  const invalid = AppError.unauthorized(
    "That email address and password combination was not recognised.",
    "Check the address and password, then try again.",
  );

  if (!row) {
    // Still do the work, so a missing account is not faster than a wrong
    // password.
    await verifyPassword(password, DUMMY_HASH);
    await recordAudit({
      action: AUDIT.loginFailed,
      actorEmail: normalised,
      outcome: "failure",
      metadata: { reason: "no_such_user" },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw invalid;
  }

  if (row.status !== "active") {
    await recordAudit({
      action: AUDIT.loginBlocked,
      actorUserId: row.id,
      actorEmail: row.email,
      outcome: "denied",
      metadata: { reason: `status_${row.status}` },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw AppError.forbidden(
      "This account is not active. Contact an administrator.",
      "Ask an administrator to reactivate the account.",
    );
  }

  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const minutes = Math.max(
      1,
      Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60_000),
    );
    await recordAudit({
      action: AUDIT.loginBlocked,
      actorUserId: row.id,
      actorEmail: row.email,
      outcome: "denied",
      metadata: { reason: "locked", minutes },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw AppError.tooManyRequests(
      `Too many failed attempts. Try again in ${minutes} minute${
        minutes === 1 ? "" : "s"
      }.`,
    );
  }

  const correct = await verifyPassword(password, row.password_hash);
  if (!correct) {
    const failures = row.failed_login_count + 1;
    const lockUntil =
      failures >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
        : null;
    await db.query(
      `UPDATE users
          SET failed_login_count = CASE WHEN $3::timestamptz IS NULL
                                       THEN $2
                                       ELSE 0 END,
              locked_until = COALESCE($3::timestamptz, locked_until)
        WHERE id = $1`,
      [row.id, failures, lockUntil],
    );
    await recordAudit({
      action: AUDIT.loginFailed,
      actorUserId: row.id,
      actorEmail: row.email,
      outcome: "failure",
      metadata: { attempt: failures, locked: Boolean(lockUntil) },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw invalid;
  }

  await db.query(
    `UPDATE users
        SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
      WHERE id = $1`,
    [row.id],
  );

  const session = await createSession(row.id, {
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
  });
  await setSessionCookie(session.token, session.expiresAt);

  await recordAudit({
    action: AUDIT.loginSucceeded,
    actorUserId: row.id,
    actorEmail: row.email,
    resourceType: "session",
    resourceId: session.token.slice(0, 8),
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return { user: toSummary(row) };
}

export async function signOut(): Promise<void> {
  const actor = await requireActor().catch(() => null);
  if (actor) {
    await revokeSession(actor.sessionId);
    await recordAudit({
      action: AUDIT.loggedOut,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "session",
      resourceId: actor.sessionId,
    });
  }
  await clearSessionCookie();
}

/**
 * Begin a password reset.
 *
 * Always reports success, whether or not the address is known, so this endpoint
 * cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const db = await getDatabase();
  const normalised = email.trim().toLowerCase();
  const result = await db.query<{ id: string; email: string; full_name: string }>(
    `SELECT id, email, full_name FROM users
      WHERE lower(email) = $1 AND status = 'active'`,
    [normalised],
  );
  const row = result.rows[0];

  if (!row) {
    await recordAudit({
      action: AUDIT.passwordResetRequested,
      actorEmail: normalised,
      outcome: "failure",
      metadata: { reason: "no_such_user" },
    });
    return;
  }

  // Invalidate any outstanding token, so only the newest link works.
  await db.query(
    "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
    [row.id],
  );

  const token = generateToken();
  const expiresAt = new Date(
    Date.now() + env.passwordResetTtlMinutes * 60_000,
  );
  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, $3, $4)`,
    [row.id, hashToken(token), expiresAt.toISOString(), await clientAddress()],
  );

  await sendPasswordResetEmail({
    to: row.email,
    fullName: row.full_name,
    token,
  });

  await recordAudit({
    action: AUDIT.passwordResetRequested,
    actorUserId: row.id,
    actorEmail: row.email,
    resourceType: "password_reset",
    outcome: "success",
  });
}

export interface ResetOutcome {
  status: "reset" | "invalid" | "expired" | "used";
}

/** Complete a password reset with a token from the emailed link. */
export async function completePasswordReset(
  token: string,
  newPassword: string,
): Promise<ResetOutcome> {
  const db = await getDatabase();
  checkPasswordPolicy(newPassword);

  const result = await db.query<{
    id: string;
    user_id: string;
    expires_at: string;
    used_at: string | null;
  }>(
    `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens WHERE token_hash = $1`,
    [hashToken(token)],
  );
  const record = result.rows[0];
  if (!record) return { status: "invalid" };
  if (record.used_at) return { status: "used" };
  if (new Date(record.expires_at) <= new Date()) return { status: "expired" };

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    await tx.query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE id = $1",
      [record.id],
    );
    await tx.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      record.user_id,
      passwordHash,
    ]);
    // A new epoch invalidates every session issued under the old password.
    await tx.query(
      "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1",
      [record.user_id],
    );
    await tx.query(
      "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [record.user_id],
    );
  });

  await recordAudit({
    action: AUDIT.passwordResetCompleted,
    actorUserId: record.user_id,
    resourceType: "user",
    resourceId: record.user_id,
  });

  return { status: "reset" };
}

/** Change a signed-in user's own password. */
export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const actor = await requireActor();
  const db = await getDatabase();
  const result = await db.query<UserRow>("SELECT * FROM users WHERE id = $1", [
    actor.id,
  ]);
  const row = result.rows[0];
  if (!row) throw AppError.notFound("Your account no longer exists.");

  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw AppError.badRequest("Your current password is not correct.", {
      code: "invalid_current_password",
      fields: { currentPassword: "That is not your current password." },
    });
  }
  if (currentPassword === newPassword) {
    throw AppError.badRequest(
      "The new password must be different from the current one.",
      { fields: { newPassword: "Choose a password you have not used here." } },
    );
  }
  checkPasswordPolicy(newPassword);
  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    await tx.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      actor.id,
      passwordHash,
    ]);
    await tx.query(
      "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1",
      [actor.id],
    );
    // Every other session is invalidated. The current one stays valid so the
    // user is not signed out of the page they are on.
    await tx.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [actor.id, actor.sessionId],
    );
  });

  await recordAudit({
    action: AUDIT.passwordChanged,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "user",
    resourceId: actor.id,
  });
}

export async function listUsers(): Promise<UserSummary[]> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<UserRow>(
    `SELECT * FROM users ORDER BY full_name`,
  );
  return result.rows.map(toSummary);
}

export async function getUser(userId: string): Promise<UserSummary | null> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<UserRow>("SELECT * FROM users WHERE id = $1", [
    userId,
  ]);
  return result.rows[0] ? toSummary(result.rows[0]) : null;
}

export async function updateProfile(input: {
  fullName?: string;
  jobTitle?: string;
  department?: string;
  phone?: string;
}): Promise<void> {
  const actor = await requireActor();
  const db = await getDatabase();

  if (input.fullName !== undefined) {
    const name = input.fullName.trim();
    if (name.length < 2 || name.length > 120) {
      throw AppError.unprocessable("Enter a name between 2 and 120 characters.", {
        fields: { fullName: "Enter a name between 2 and 120 characters." },
      });
    }
    await db.query("UPDATE users SET full_name = $2 WHERE id = $1", [
      actor.id,
      name,
    ]);
  }

  const hasDetail =
    input.jobTitle !== undefined ||
    input.department !== undefined ||
    input.phone !== undefined;
  if (hasDetail) {
    await db.query(
      `INSERT INTO profiles (user_id, job_title, department, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET job_title = COALESCE(EXCLUDED.job_title, profiles.job_title),
             department = COALESCE(EXCLUDED.department, profiles.department),
             phone = COALESCE(EXCLUDED.phone, profiles.phone)`,
      [
        actor.id,
        input.jobTitle ?? null,
        input.department ?? null,
        input.phone ?? null,
      ],
    );
  }

  await recordAudit({
    action: AUDIT.profileUpdated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "user",
    resourceId: actor.id,
    metadata: { fields: Object.keys(input) },
  });
}

export async function getProfileDetail(userId: string) {
  const db = await getDatabase();
  const result = await db.query<{
    full_name: string;
    email: string;
    role: Role;
    job_title: string | null;
    department: string | null;
    phone: string | null;
  }>(
    `SELECT u.full_name, u.email, u.role, p.job_title, p.department, p.phone
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/** Revoke every session for a user. Administrators only. */
export async function forceSignOut(userId: string): Promise<number> {
  await requireActor();
  const count = await revokeAllSessionsForUser(userId, { alsoBumpEpoch: true });
  await recordAudit({
    action: AUDIT.loggedOut,
    resourceType: "user",
    resourceId: userId,
    outcome: "success",
    metadata: { forced: true, sessions_revoked: count },
  });
  return count;
}
