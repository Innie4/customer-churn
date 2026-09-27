/**
 * Session management.
 *
 * The session cookie carries an opaque random token. Only the token's SHA-256
 * digest is stored, so a database disclosure does not hand out live sessions
 * and a session can be revoked by deleting its row.
 *
 * Cookies are httpOnly, sameSite=lax and secure in production, which is what
 * makes the platform resistant to cross-site scripting and cross-site request
 * forgery on the session cookie.
 */

import "server-only";

import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDatabase } from "../../../db/client";
import { env } from "../env";
import { generateToken, hashToken } from "./password";
import { SESSION_COOKIE, SESSION_TTL_COOKIE } from "./constants";

export { SESSION_COOKIE, SESSION_TTL_COOKIE };

export type Role = "admin" | "analyst" | "viewer";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  sessionId: string;
  expiresAt: string;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  status: string;
}

interface SessionRow extends UserRow {
  session_id: string;
  expires_at: string;
  session_epoch: number;
  user_epoch: number;
}

/** Derive the cookie-signing key from SESSION_SECRET. */
function signingKey(): Buffer {
  return createHmac("sha256", env.sessionSecret)
    .update("churn-session-cookie-v1")
    .digest();
}

function sign(value: string): string {
  return createHmac("sha256", signingKey()).update(value).digest("base64url");
}

/**
 * Wrap a token so a tampered cookie is rejected before any database lookup.
 *
 * The digest is not a substitute for the server-side session check; it just
 * avoids a pointless query for a cookie that was edited in the browser.
 */
function seal(token: string): string {
  return `${token}.${sign(token)}`;
}

function unseal(sealed: string): string | null {
  const index = sealed.lastIndexOf(".");
  if (index <= 0) return null;
  const token = sealed.slice(0, index);
  const provided = Buffer.from(sealed.slice(index + 1));
  const expected = Buffer.from(sign(token));
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? token : null;
}

function sessionTtlMs(): number {
  const hours = Number.isFinite(env.sessionTtlHours) ? env.sessionTtlHours : 8;
  return Math.max(1, hours) * 60 * 60 * 1000;
}

export async function createSession(
  userId: string,
  context: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const db = await getDatabase();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + sessionTtlMs());

  await db.query(
    `INSERT INTO sessions
       (user_id, token_hash, session_epoch, user_agent, ip_address, expires_at)
     SELECT $1, $2, session_epoch, $3, $4, $5 FROM users WHERE id = $1`,
    [
      userId,
      hashToken(token),
      context.userAgent ?? null,
      context.ipAddress ?? null,
      expiresAt.toISOString(),
    ],
  );

  return { token, expiresAt };
}

export async function setSessionCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies();
  const maxAge = Math.max(
    1,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  store.set(SESSION_COOKIE, seal(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    maxAge,
  });
  // A readable copy so the client can tell whether the session is close to
  // expiry and prompt a re-authentication. Carries nothing sensitive.
  store.set(SESSION_TTL_COOKIE, String(expiresAt.getTime()), {
    httpOnly: false,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    maxAge,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(SESSION_TTL_COOKIE);
}

/**
 * Resolve the current session, or null.
 *
 * Returns null for a missing cookie, a tampered cookie, an unknown token, a
 * revoked session, an expired session, a suspended user, or a session issued
 * before the user's password last changed.
 */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const token = unseal(raw);
  if (!token) return null;

  const db = await getDatabase();
  const result = await db.query<SessionRow>(
    `SELECT s.id AS session_id, s.expires_at, s.session_epoch,
            u.id, u.email, u.full_name, u.role, u.status,
            u.session_epoch AS user_epoch
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;
  if (row.status !== "active") return null;
  // A session issued before a password change or a forced sign-out carries an
  // older epoch, so it no longer matches the user's current epoch.
  if (row.session_epoch !== row.user_epoch) return null;

  // Touch the session so an active user is not signed out mid-use.
  await db.query(
    "UPDATE sessions SET last_seen_at = now() WHERE id = $1",
    [row.session_id],
  ).catch(() => undefined);

  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    sessionId: row.session_id,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  const db = await getDatabase();
  await db.query(
    "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
}

export async function revokeAllSessionsForUser(
  userId: string,
  options: { alsoBumpEpoch?: boolean } = {},
): Promise<number> {
  const db = await getDatabase();
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  if (options.alsoBumpEpoch) {
    // Bumping the epoch invalidates anything issued before this point, even if
    // a session row was somehow recreated with an old epoch.
    await db.query(
      "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1",
      [userId],
    );
  }
  return result.rowCount;
}

export async function deleteExpiredSessions(): Promise<number> {
  const db = await getDatabase();
  const result = await db.query(
    "DELETE FROM sessions WHERE expires_at < now() OR revoked_at < now() - interval '7 days'",
  );
  return result.rowCount;
}

/** Capability checks, expressed once so every route agrees. */
export function canManageModels(role: Role): boolean {
  return role === "admin" || role === "analyst";
}

export function canActivateModels(role: Role): boolean {
  return role === "admin" || role === "analyst";
}

export function canAdminister(role: Role): boolean {
  return role === "admin";
}

export function canUpload(role: Role): boolean {
  return role === "admin" || role === "analyst";
}

export function canCreateActions(role: Role): boolean {
  return role === "admin" || role === "analyst";
}
