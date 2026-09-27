/**
 * Shared plumbing for route handlers.
 *
 * Keeps every endpoint to three lines: a capability check, a call into the data
 * access layer, and a response. Authorisation lives in the DAL, so a route
 * cannot forget it, and error shaping is identical everywhere.
 */

import "server-only";

import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, apiError, apiSuccess, newRequestId } from "./api";
import { getSession } from "./auth/session";
import { AUDIT, clientAddress, clientUserAgent, recordAudit } from "./audit";
import { getDatabase } from "../../db/client";
import {
  canActivateModels,
  canAdminister,
  canCreateActions,
  canManageModels,
  canUpload,
  type Role,
} from "./auth/session";

/**
 * The context a route handler receives from Next.js.
 *
 * Deliberately narrow. Next validates that the second parameter accepts exactly
 * this shape, so the richer internal context is built inside the wrapper rather
 * than being part of the exported signature.
 */
export interface RouteContext {
  params: Promise<Record<string, string>>;
}

export interface HandlerContext {
  params: Promise<Record<string, string>>;
  request: Request;
  operation: string;
}

export interface EndpointOptions {
  /** Set false for endpoints reachable without a session, such as sign-in. */
  auth?: boolean;
  /** Which role capability is required. Omit for authenticated-only. */
  capability?:
    | "read"
    | "upload"
    | "manageModels"
    | "activateModels"
    | "createActions"
    | "administer";
  /** Audit action recorded on success. */
  auditAction?: string;
  /** Build the resource id for the audit record from the result. */
  auditResource?: (result: unknown, context: HandlerContext) => {
    resourceType?: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  } | null;
  status?: number;
  /** Run before the handler, for cases a capability check does not cover. */
  guard?: (session: {
    id: string;
    email: string;
    role: Role;
  }) => Promise<void> | void;
}

function permits(role: Role, capability: EndpointOptions["capability"]): boolean {
  switch (capability) {
    case undefined:
    case "read":
      return true;
    case "upload":
      return canUpload(role);
    case "manageModels":
      return canManageModels(role);
    case "activateModels":
      return canActivateModels(role);
    case "createActions":
      return canCreateActions(role);
    case "administer":
      return canAdminister(role);
    default:
      return false;
  }
}

/**
 * Wrap a route handler with authentication, authorisation, auditing and
 * uniform error handling.
 *
 * The handler's return value is serialised into the standard success envelope.
 * A handler that needs to control its own response body — a file download or a
 * stream — returns a `Response` and it is passed through unchanged, while still
 * being authenticated, authorised, audited and error-handled the same way.
 */
export function endpoint<Result>(
  operation: string,
  options: EndpointOptions,
  handler: (context: HandlerContext) => Promise<Result>,
) {
  return async (
    request: Request,
    routeContext: RouteContext,
  ): Promise<Response> => {
    const requestId = newRequestId();
    const ctx: HandlerContext = {
      params: routeContext.params,
      request,
      operation,
    };
    try {
      // Endpoints that must work before a session exists, such as sign-in and
      // password reset, opt out with `auth: false`.
      const session = options.auth === false ? null : await getSession();
      if (options.auth !== false && !session) {
        throw AppError.unauthorized(
          "Your session has ended or was never established.",
          "Sign in and try again.",
        );
      }
      if (session && !permits(session.role, options.capability)) {
        await recordAudit({
          action: AUDIT.accessDenied,
          actorUserId: session.id,
          actorEmail: session.email,
          resourceType: "endpoint",
          resourceId: operation,
          outcome: "denied",
          metadata: {
            required: options.capability ?? "authenticated",
            role: session.role,
          },
          ipAddress: await clientAddress(),
          userAgent: await clientUserAgent(),
          requestId,
        });
        throw AppError.forbidden(
          "Your role does not allow this action.",
          "Ask an administrator if you need this access.",
        );
      }
      if (options.guard) {
        if (!session) {
          throw AppError.unauthorized(
            "You need to sign in to continue.",
            "Sign in and try again.",
          );
        }
        await options.guard({
          id: session.id,
          email: session.email,
          role: session.role,
        });
      }

      const result = await handler(ctx);

      // A handler that has already built a response — a file download, a
      // stream — returns it untouched, so the bytes are not wrapped in the JSON
      // envelope every other endpoint uses.
      if (result instanceof Response) {
        return result;
      }

      if (options.auditAction && session) {
        const resource = options.auditResource?.(result, ctx) ?? {};
        await recordAudit({
          action: options.auditAction,
          actorUserId: session.id,
          actorEmail: session.email,
          requestId,
          ipAddress: await clientAddress(),
          userAgent: await clientUserAgent(),
          ...resource,
        });
      }

      return apiSuccess(result, { status: options.status ?? 200 });
    } catch (error) {
      if (error instanceof ZodError) {
        const fields: Record<string, string> = {};
        for (const issue of error.issues) {
          const key = issue.path.join(".") || "_form";
          if (!fields[key]) fields[key] = issue.message;
        }
        return apiError(
          AppError.unprocessable("Some of the values submitted are not valid.", {
            fields,
            nextAction: "Correct the highlighted values and try again.",
          }),
          requestId,
        );
      }
      return errorResponse(error, operation, requestId);
    }
  };
}

function errorResponse(
  error: unknown,
  operation: string,
  requestId: string,
): NextResponse {
  if (error instanceof AppError) {
    // 401 and 403 on an API call get a JSON body, not a redirect, so a client
    // can distinguish them from a 500.
    return apiError(error, requestId);
  }
  console.error(`[api:${operation}] unhandled`, {
    requestId,
    error: error instanceof Error ? error.message : error,
  });
  return apiError(AppError.internal(), requestId);
}

/** Validate a JSON body against a schema, mapping failure to a 422. */
export async function body<Schema>(
  request: Request,
  schema: ZodType<Schema>,
): Promise<Schema> {
  let raw: unknown;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      raw = await request.json();
    } catch {
      throw AppError.badRequest("The request body is not valid JSON.", {
        code: "invalid_json",
        nextAction: "Check the request body and try again.",
      });
    }
  } else {
    try {
      raw = Object.fromEntries(await request.formData());
    } catch {
      throw AppError.badRequest("The request body could not be read.", {
        code: "unreadable_body",
      });
    }
  }
  return schema.parse(raw);
}

/** Read a validated query string parameter. */
export function queryParam(
  request: Request,
  name: string,
  fallback?: string,
): string | undefined {
  const url = new URL(request.url);
  return url.searchParams.get(name) ?? fallback;
}

export function queryInt(
  request: Request,
  name: string,
  fallback: number,
): number {
  const raw = queryParam(request, name);
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Extract an uploaded file from already-parsed multipart form data.
 *
 * A request body can only be read once, so handlers that need both a file and
 * the surrounding text fields must parse the form a single time and use this
 * helper rather than calling `uploadedFile` as well.
 */
export async function formDataFile(
  form: FormData,
  field = "file",
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const { env } = await import("./env");
  const value = form.get(field);
  if (!value || typeof value === "string") {
    throw AppError.badRequest(`No file was provided in the "${field}" field.`, {
      code: "missing_file",
      fields: { [field]: "Choose a file to upload." },
    });
  }
  const file = value as File;
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > env.maxUploadBytes) {
    throw AppError.tooLarge(
      `That file is larger than the ${Math.round(
        env.maxUploadBytes / (1024 * 1024),
      )} MB limit.`,
    );
  }
  return {
    buffer,
    filename: file.name || "upload.csv",
    contentType: file.type || "text/csv",
  };
}

/**
 * Read a single uploaded file from a multipart body, with a size guard.
 *
 * Consumes the request body. If the handler also needs the other form fields,
 * parse the form once with `request.formData()` and use `formDataFile` instead.
 */
export async function uploadedFile(
  request: Request,
  field = "file",
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  return formDataFile(await request.formData(), field);
}

/** Confirm the database is reachable, so a 500 is not really a 503. */
export async function assertDatabaseReachable(): Promise<void> {
  try {
    const db = await getDatabase();
    await db.query("SELECT 1");
  } catch {
    throw AppError.serviceUnavailable(
      "database",
      "Check that the database is running and reachable.",
    );
  }
}
