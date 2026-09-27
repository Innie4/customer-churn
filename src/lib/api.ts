/**
 * API response and error shapes.
 *
 * Every route returns the same envelope, so a client never has to guess whether
 * an error arrived as `{ detail: ... }` or `{ error: ... }`.
 *
 * Errors carry a code, a message written for the person reading the screen, and
 * optionally a next action. They never carry a stack trace, a SQL fragment or
 * a configuration value.
 */

import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { DatabaseError } from "../../db/client";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** What the user can do about it, when there is something. */
    nextAction?: string;
    /** Field-level messages, for form display. */
    fields?: Record<string, string>;
    requestId?: string;
  };
}

export interface ApiSuccessBody<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** An error the application raises deliberately, with a user-facing message. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly nextAction?: string;
  readonly fields?: Record<string, string>;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      nextAction?: string;
      fields?: Record<string, string>;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.nextAction = options.nextAction;
    this.fields = options.fields;
    this.details = options.details;
  }

  static badRequest(
    message: string,
    options: {
      code?: string;
      fields?: Record<string, string>;
      nextAction?: string;
    } = {},
  ): AppError {
    return new AppError(400, options.code ?? "bad_request", message, options);
  }

  static unauthorized(
    message = "You need to sign in to continue.",
    nextAction = "Sign in and try again.",
  ): AppError {
    return new AppError(401, "unauthorized", message, { nextAction });
  }

  static forbidden(
    message = "Your role does not allow this action.",
    nextAction = "Ask an administrator if you need this access.",
  ): AppError {
    return new AppError(403, "forbidden", message, { nextAction });
  }

  static notFound(
    message = "That record does not exist.",
    nextAction = "Go back to the list and try another record.",
  ): AppError {
    return new AppError(404, "not_found", message, { nextAction });
  }

  static conflict(
    message: string,
    nextAction = "Reload the page to see the current state.",
  ): AppError {
    return new AppError(409, "conflict", message, { nextAction });
  }

  static tooLarge(
    message: string,
    nextAction = "Upload a smaller file.",
  ): AppError {
    return new AppError(413, "payload_too_large", message, { nextAction });
  }

  static unprocessable(
    message: string,
    options: {
      code?: string;
      fields?: Record<string, string>;
      nextAction?: string;
    } = {},
  ): AppError {
    return new AppError(422, options.code ?? "validation_failed", message, options);
  }

  static tooManyRequests(
    message = "Too many attempts. Wait a moment and try again.",
    nextAction = "Try again in a minute.",
  ): AppError {
    return new AppError(429, "rate_limited", message, { nextAction });
  }

  /** 500. The message is deliberately generic; the detail goes to the log. */
  static internal(
    message = "Something went wrong on our side.",
    nextAction = "Try again. If it keeps happening, check the server log.",
  ): AppError {
    return new AppError(500, "internal_error", message, { nextAction });
  }

  /** 502/503 for a dependency that is not answering. */
  static serviceUnavailable(
    service: string,
    nextAction: string,
  ): AppError {
    return new AppError(
      503,
      "dependency_unavailable",
      `The ${service} is not responding.`,
      { nextAction },
    );
  }
}

let requestCounter = 0;

/** Short, non-sequential-per-request identifier used in logs and errors. */
export function newRequestId(): string {
  requestCounter = (requestCounter + 1) % 1_000_000;
  const stamp = Date.now().toString(36);
  return `${stamp}-${requestCounter.toString(36)}`;
}

export function apiSuccess<T>(
  data: T,
  init: { status?: number; meta?: Record<string, unknown> } = {},
): NextResponse {
  return NextResponse.json(
    { data, ...(init.meta ? { meta: init.meta } : {}) } satisfies
      | ApiSuccessBody<T>
      | { data: T },
    { status: init.status ?? 200 },
  );
}

export function apiError(
  error: AppError,
  requestId?: string,
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.nextAction ? { nextAction: error.nextAction } : {}),
        ...(error.fields ? { fields: error.fields } : {}),
        ...(requestId ? { requestId } : {}),
      },
    },
    { status: error.status },
  );
}

/**
 * Turn any thrown value into a response.
 *
 * Unexpected errors are logged in full and reported generically, so an
 * implementation detail never reaches the browser.
 */
export function handleError(
  error: unknown,
  context: { operation: string; requestId?: string },
): NextResponse<ApiErrorBody> {
  if (error instanceof AppError) {
    return apiError(error, context.requestId);
  }

  if (error instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "_form";
      if (!fields[key]) fields[key] = issue.message;
    }
    return apiError(
      AppError.unprocessable("Some of the values submitted are not valid.", {
        fields,
        nextAction: "Correct the highlighted fields and submit again.",
      }),
      context.requestId,
    );
  }

  if (error instanceof DatabaseError) {
    // Constraint names are safe to surface: they are schema identifiers, not
    // data, and naming the constraint is what makes the message actionable.
    if (error.code === "23505") {
      return apiError(
        AppError.conflict(
          "That record already exists.",
          "Reload the page to see what is already there.",
        ),
        context.requestId,
      );
    }
    if (error.code === "23503") {
      return apiError(
        AppError.badRequest(
          "That operation refers to a record that no longer exists.",
          { nextAction: "Reload the page and try again." },
        ),
        context.requestId,
      );
    }
    if (error.code === "23514") {
      return apiError(
        AppError.unprocessable(
          "That value is not allowed by the data rules.",
          { nextAction: "Correct the value and try again." },
        ),
        context.requestId,
      );
    }
    if (error.code === "connection_failed") {
      return apiError(
        AppError.serviceUnavailable(
          "database",
          "Check that the database is running and DATABASE_URL is correct.",
        ),
        context.requestId,
      );
    }
    console.error(`[${context.operation}] database error`, error);
    return apiError(AppError.internal(), context.requestId);
  }

  console.error(`[${context.operation}] unhandled error`, error);
  return apiError(AppError.internal(), context.requestId);
}

/** Parse and validate a JSON body, converting a failure into a 422. */
export async function parseJson<Schema>(
  request: Request,
  schema: ZodType<Schema>,
): Promise<Schema> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw AppError.badRequest("The request body is not valid JSON.", {
      code: "invalid_json",
      nextAction: "Check the request body and try again.",
    });
  }
  return schema.parse(raw);
}
