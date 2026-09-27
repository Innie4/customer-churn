/**
 * A test harness for the application's request handlers.
 *
 * The point is to exercise the real code: the real database with its real
 * constraints and triggers, the real session sealing, the real authorisation
 * checks, and the real multipart body handling. Only two things are substituted
 * — the database is an isolated in-memory one, and the machine learning service
 * is a local stub, because training a model in a unit test would be absurd.
 *
 * Handlers are called directly as functions, which is the same interface Next
 * uses: a `Request` and a route context with `params`.
 */

import {
  createTestDatabase,
  migrateClient,
  setDatabaseForTesting,
  type SqlClient,
} from "../../db/client";
// The primitives, not `password.ts`: that module is marked `server-only` and
// refuses to load outside a React server component, which is exactly what this
// file is not.
import { derivePasswordHash } from "../../src/lib/auth/crypto";
import { checkPasswordPolicy } from "../../src/lib/auth/policy";
import {
  SESSION_COOKIE,
  createSession,
  setSessionCookie,
} from "../../src/lib/auth/session";
import type { Role } from "../../src/lib/auth/session";

/**
 * The cookie store the mocked `next/headers` hands back.
 *
 * Mutable so a handler can set or clear cookies and the test can read the
 * result, which is how a sign-in or a sign-out is asserted.
 */
export class CookieJar {
  private readonly values = new Map<string, string>();

  get(name: string): { name: string; value: string } | undefined {
    const value = this.values.get(name);
    return value === undefined ? undefined : { name, value };
  }

  getAll(): { name: string; value: string }[] {
    return [...this.values.entries()].map(([name, value]) => ({ name, value }));
  }

  set(name: string, value: string): void {
    // The options a real cookie store takes — httpOnly, sameSite, maxAge — do
    // not affect a test that reads the value back, so they are not modelled.
    this.values.set(name, value);
  }

  delete(name: string): void {
    this.values.delete(name);
  }

  header(): string {
    return [...this.values.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

/** Set by the harness so the `next/headers` mock can hand back one jar. */
export const activeJar = new CookieJar();

/** Reset the jar between tests. */
export function resetCookies(): void {
  for (const cookie of activeJar.getAll()) activeJar.delete(cookie.name);
}

export interface AppContext {
  db: SqlClient;
  close: () => Promise<void>;
  createUser: (options: {
    email: string;
    role?: Role;
    password?: string;
    fullName?: string;
    status?: "active" | "suspended" | "invited";
  }) => Promise<string>;
  signIn: (userId: string) => Promise<string>;
  /** A `Request` carrying the signed-in session cookie. */
  as: (
    userId: string,
    init?: RequestInit & { url?: string },
  ) => Promise<Request>;
  /** A `Request` with no session at all. */
  anonymous: (init?: RequestInit & { url?: string }) => Request;
  /** A route context for a dynamic segment. */
  context: (params: Record<string, string>) => { params: Promise<Record<string, string>> };
}

let counter = 0;

export async function createAppContext(): Promise<AppContext> {
  const db = await createTestDatabase();
  const migration = await migrateClient(db);
  if (migration.failed) {
    throw new Error(
      `Migration ${migration.failed.id} failed: ${migration.failed.error}`,
    );
  }
  setDatabaseForTesting(db);
  resetCookies();

  const createUser: AppContext["createUser"] = async (options) => {
    counter += 1;
    const email = options.email.toLowerCase();
    const password = options.password ?? "Correct-Horse-Battery-9";
    // The same policy the sign-up path applies, so a seeded account meets the
    // same bar as one created through the application.
    checkPasswordPolicy(password);
    const passwordHash = await derivePasswordHash(password);
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        email,
        passwordHash,
        options.fullName ?? `User ${counter}`,
        options.role ?? "analyst",
        options.status ?? "active",
      ],
    );
    return result.rows[0].id;
  };

  const signIn: AppContext["signIn"] = async (userId) => {
    // The real session row and the real sealed cookie, written through the
    // mocked cookie store, so the cookie format is exercised rather than
    // bypassed. The token itself is never available to the test, which is the
    // point: it should not be.
    const { token, expiresAt } = await createSession(userId, {});
    await setSessionCookie(token, expiresAt);
    const cookie = activeJar.get(SESSION_COOKIE);
    if (!cookie) throw new Error("setSessionCookie wrote no session cookie");
    return cookie.value;
  };

  return {
    db,
    close: async () => {
      setDatabaseForTesting(null);
      await db.close();
    },
    createUser,
    signIn,
    as: async (userId, init = {}) => {
      await signIn(userId);
      return new Request(init.url ?? "http://localhost/api/test", {
        ...init,
        headers: withHeaders(init.headers, {
          cookie: activeJar.header(),
          ...jsonContentType(init),
        }),
      });
    },
    anonymous: (init = {}) => {
      // The cookie jar is what the handlers read, so an anonymous request has
      // to clear it. Otherwise a test that signs in first would find its
      // "anonymous" call still authenticated.
      resetCookies();
      return new Request(init.url ?? "http://localhost/api/test", {
        ...init,
        headers: withHeaders(init.headers, jsonContentType(init)),
      });
    },
    context: (params) => ({ params: Promise.resolve(params) }),
  };
}

/**
 * Set a JSON content type for a string body.
 *
 * The body reader branches on the content type, so a JSON body without one is
 * treated as form data and fails to parse. A FormData body needs nothing, since
 * fetch sets the multipart type itself.
 */
function jsonContentType(init: RequestInit): Record<string, string> {
  return typeof init.body === "string"
    ? { "content-type": "application/json" }
    : {};
}

/** Merge caller headers over defaults, so a test can still override. */
function withHeaders(
  provided: HeadersInit | undefined,
  defaults: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...defaults };
  if (provided) {
    for (const [key, value] of new Headers(provided)) merged[key] = value;
  }
  return merged;
}

/** The standard success envelope the API returns. */
export async function successBody(
  response: Response,
): Promise<{ data: unknown }> {
  return (await response.json()) as { data: unknown };
}

/** The standard error envelope. */
export async function errorBody(
  response: Response,
): Promise<{ error: { code: string; message: string; nextAction?: string } }> {
  return (await response.json()) as {
    error: { code: string; message: string; nextAction?: string };
  };
}

/** A small but realistic CSV, as a Buffer for a multipart upload. */
export const SAMPLE_CSV = [
  "customerID,gender,SeniorCitizen,Partner,Dependents,tenure,PhoneService,MultipleLines,InternetService,OnlineSecurity,OnlineBackup,DeviceProtection,TechSupport,StreamingTV,StreamingMovies,Contract,PaperlessBilling,PaymentMethod,MonthlyCharges,TotalCharges,Churn",
  "C0001,Male,0,Yes,No,12,Yes,No,Fiber optic,No,Yes,No,No,No,No,Month-to-month,Yes,Electronic check,95.5,1146.0,Yes",
  "C0002,Female,0,No,Yes,48,Yes,No,DSL,Yes,No,Yes,Yes,Yes,Yes,Two year,No,Credit card,72.4,3477.6,No",
  "C0003,Male,1,Yes,No,3,Yes,Yes,Fiber optic,No,No,No,No,Yes,No,Month-to-month,Yes,Electronic check,88.9,266.7,Yes",
  "C0004,Female,0,Yes,Yes,70,Yes,No,DSL,Yes,Yes,Yes,Yes,Yes,Yes,One year,No,Bank transfer,52.6,3682.0,No",
].join("\n");

export function csvUpload(
  body: string = SAMPLE_CSV,
  filename = "churn.csv",
  fields: Record<string, string> = {},
): FormData {
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/csv" }), filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}
