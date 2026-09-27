/**
 * Audit logging.
 *
 * Records consequential activity: who did what, to which resource, with what
 * outcome. Never records a credential, a token, or a request body.
 *
 * Audit writes never block the operation they describe. If the insert fails the
 * failure is logged and the operation carries on, because losing the audit
 * entry is bad but refusing a legitimate action is worse.
 */

import "server-only";

import { getDatabase } from "../../db/client";
import { env } from "./env";

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditEvent {
  action: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Keys that must never reach the audit table, at any nesting depth.
 *
 * A caller that accidentally passes a password in metadata is a mistake worth
 * defending against rather than a mistake worth trusting not to happen.
 */
const FORBIDDEN_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "passwordhash",
  "token",
  "tokenhash",
  "sessiontoken",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "session_secret",
  "encryption_key",
  "service_role_key",
  "connectionstring",
  "database_url",
]);

const MAX_STRING = 500;

function sanitise(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitise(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = sanitise(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    const db = await getDatabase();
    await db.query(
      `INSERT INTO audit_logs
         (actor_user_id, actor_email, action, resource_type, resource_id,
          outcome, metadata, ip_address, user_agent, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        event.actorUserId ?? null,
        event.actorEmail ?? null,
        event.action,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.outcome ?? "success",
        JSON.stringify(sanitise(event.metadata ?? {})),
        event.ipAddress ?? null,
        (event.userAgent ?? "").slice(0, 500) || null,
        event.requestId ?? null,
      ],
    );
  } catch (error) {
    console.error("[audit] could not record an audit event", {
      action: event.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Every audit action the application can record, in one place. */
export const AUDIT = {
  loginSucceeded: "auth.login.succeeded",
  loginFailed: "auth.login.failed",
  loginBlocked: "auth.login.blocked",
  loggedOut: "auth.logout",
  sessionExpired: "auth.session.expired",
  passwordResetRequested: "auth.password_reset.requested",
  passwordResetCompleted: "auth.password_reset.completed",
  passwordChanged: "auth.password.changed",
  profileUpdated: "profile.updated",
  datasetUploaded: "dataset.uploaded",
  datasetInspected: "dataset.inspected",
  datasetValidated: "dataset.validated",
  datasetPreprocessed: "dataset.preprocessed",
  datasetDeleted: "dataset.deleted",
  trainingStarted: "model.training.started",
  trainingCompleted: "model.training.completed",
  trainingFailed: "model.training.failed",
  modelActivated: "model.activated",
  modelDeactivated: "model.deactivated",
  modelReviewed: "model.risk_review.updated",
  predictionsGenerated: "prediction.generated",
  predictionFailed: "prediction.failed",
  explanationGenerated: "explanation.generated",
  explanationFailed: "explanation.failed",
  strategyCreated: "retention.strategy.created",
  strategyUpdated: "retention.strategy.updated",
  strategyApproved: "retention.strategy.approved",
  actionCreated: "retention.action.created",
  actionUpdated: "retention.action.updated",
  actionStatusChanged: "retention.action.status_changed",
  reportGenerated: "report.generated",
  reportFailed: "report.failed",
  settingUpdated: "settings.updated",
  accessDenied: "access.denied",
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

/** Read the client address for the audit record, when the platform exposes it. */
export async function clientAddress(): Promise<string | null> {
  if (env.isTest) return "127.0.0.1";
  const { headers } = await import("next/headers");
  const store = await headers();
  const forwarded = store.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return store.get("x-real-ip") ?? null;
}

export async function clientUserAgent(): Promise<string | null> {
  const { headers } = await import("next/headers");
  const store = await headers();
  return store.get("user-agent");
}
