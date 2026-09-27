/**
 * Authentication and session tests.
 *
 * These exercise the real scrypt hashing, the real sealed cookie and the real
 * session lookup, because those are the parts an attacker would aim at and the
 * parts most likely to be subtly wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as harness from "../support/harness";
import { verifyPasswordHash, generateToken, hashToken } from "@/lib/auth/crypto";
import { hashPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, SESSION_TTL_COOKIE } from "@/lib/auth/session";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as getSession } from "@/app/api/auth/session/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";

vi.mock("next/headers", () => ({
  cookies: async () => harness.activeJar,
  headers: async () => new Headers(),
}));


let app: Awaited<ReturnType<typeof harness.createAppContext>>;

/**
 * Remove the per-request correlation id from an error body.
 *
 * Two responses to the same kind of failure differ only by this value, which
 * exists so an operator can find the matching log line. It carries no
 * information about the request, so it is excluded before comparing.
 */
function stripRequestId(text: string): string {
  const parsed = JSON.parse(text) as { error?: Record<string, unknown> };
  if (parsed.error) delete parsed.error.requestId;
  return JSON.stringify(parsed);
}

beforeAll(async () => {
  app = await harness.createAppContext();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  harness.resetCookies();
});

describe("password hashing", () => {
  it("accepts the password it hashed", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-9");
    expect(hash.startsWith("scrypt$")).toBe(true);
    await expect(verifyPasswordHash("Correct-Horse-Battery-9", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-9");
    await expect(verifyPasswordHash("correct-horse-battery-9", hash)).resolves.toBe(
      false,
    );
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-9");
    expect(hash).not.toContain("Correct-Horse-Battery-9");
  });

  it("salts, so the same password hashes differently each time", async () => {
    const a = await hashPassword("Correct-Horse-Battery-9");
    const b = await hashPassword("Correct-Horse-Battery-9");
    expect(a).not.toBe(b);
    await expect(verifyPasswordHash("Correct-Horse-Battery-9", b)).resolves.toBe(true);
  });

  it("carries its cost parameters, so they can be raised later", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-9");
    const [scheme, n, r, p] = hash.split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBeGreaterThan(0);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
  });

  it.each([
    ["", "too short"],
    ["Short-1a", "too short"],
    ["alllowercase1", "no uppercase"],
    ["ALLUPPERCASE1", "no lowercase"],
    ["NoDigitsHere", "no digit"],
  ])("rejects %s (%s)", async (password) => {
    await expect(hashPassword(password)).rejects.toThrow();
  });

  it("refuses to verify against a malformed stored hash", async () => {
    await expect(verifyPasswordHash("anything", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPasswordHash("anything", "scrypt$1$2$3")).resolves.toBe(false);
  });

  it("refuses a stored hash demanding an absurd allocation", async () => {
    // A hostile row must not be able to make the process allocate enormously.
    const hostile = `scrypt$${1 << 21}$8$1$${Buffer.from("s").toString("base64")}$${Buffer.from("h").toString("base64")}`;
    await expect(verifyPasswordHash("anything", hostile)).resolves.toBe(false);
  });
});

describe("session cookie sealing", () => {
  it("stores only a hash, so the cookie is the sole bearer of the session", async () => {
    const id = await app.createUser({ email: "sealed@example.com" });
    await app.signIn(id);
    const cookie = harness.activeJar.get(SESSION_COOKIE)!.value;
    expect(cookie.length).toBeGreaterThan(20);

    const sessions = await app.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions WHERE user_id = $1",
      [id],
    );
    // A database disclosure must not yield usable session cookies.
    expect(cookie).not.toContain(sessions.rows[0].token_hash);
    expect(sessions.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different cookie each time, so it is not guessable", async () => {
    const id = await app.createUser({ email: "random@example.com" });
    const first = await app.signIn(id);
    const second = await app.signIn(id);
    expect(first).not.toBe(second);
  });

  it("rejects a tampered cookie", async () => {
    const id = await app.createUser({ email: "tampered@example.com" });
    const good = await app.signIn(id);
    harness.activeJar.set(
      SESSION_COOKIE,
      good.slice(0, -6) + (good.endsWith("AAAAAA") ? "BBBBBB" : "AAAAAA"),
    );

    const response = await getSession(
      app.anonymous({ method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    const body = (await response.json()) as {
      data: { user: unknown; secondsRemaining: number };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.secondsRemaining).toBe(0);
  });

  it("rejects a garbage cookie", async () => {
    harness.activeJar.set(SESSION_COOKIE, "not-a-cookie");
    const response = await getSession(
      app.anonymous({ method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    const body = (await response.json()) as {
      data: { user: unknown; secondsRemaining: number };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.secondsRemaining).toBe(0);
  });
});

describe("POST /api/auth/login", () => {
  it("signs a valid user in and sets an httpOnly session cookie", async () => {
    const id = await app.createUser({
      email: "valid@example.com",
      password: "Correct-Horse-Battery-9",
    });
    const response = await login(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({
          email: "valid@example.com",
          password: "Correct-Horse-Battery-9",
        }),
      }),
        app.context({}),
      );

    expect(response.status).toBe(200);
    const session = harness.activeJar.get(SESSION_COOKIE);
    expect(session).toBeDefined();
    // A readable TTL copy so the client can warn before expiry.
    expect(harness.activeJar.get(SESSION_TTL_COOKIE)).toBeDefined();
    expect(id).toBeTruthy();
  });

  it("records the sign-in in the audit trail", async () => {
    await app.createUser({
      email: "audited@example.com",
      password: "Correct-Horse-Battery-9",
    });
    harness.resetCookies();
    await login(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({
          email: "audited@example.com",
          password: "Correct-Horse-Battery-9",
        }),
      }),
        app.context({}),
      );

    const rows = await app.db.query<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_logs WHERE actor_email = $1 ORDER BY created_at",
      ["audited@example.com"],
    );
    expect(rows.rows.some((r) => r.action.includes("sign_in") || r.action.includes("login"))).toBe(
      true,
    );
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await app.createUser({
      email: "real@example.com",
      password: "Correct-Horse-Battery-9",
    });

    const wrongPassword = await login(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({
          email: "real@example.com",
          password: "Wrong-Password-123",
        }),
      }),
        app.context({}),
      );
    const unknownAccount = await login(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({
          email: "nobody@example.com",
          password: "Correct-Horse-Battery-9",
        }),
      }),
        app.context({}),
      );

    // Identical apart from the request id, which is a per-request correlation
    // value and not a disclosure. If the messages differed at all, the endpoint
    // would reveal which addresses have accounts.
    expect(wrongPassword.status).toBe(unknownAccount.status);
    const a = stripRequestId(await wrongPassword.text());
    const b = stripRequestId(await unknownAccount.text());
    expect(a).toBe(b);
    expect(a).not.toMatch(/no such user|unknown user|does not exist|incorrect password/i);
  });

  it("does not create a session for a failed attempt", async () => {
    await app.createUser({
      email: "fail@example.com",
      password: "Correct-Horse-Battery-9",
    });
    harness.resetCookies();
    await login(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({
          email: "fail@example.com",
          password: "Wrong-Password-123",
        }),
      }),
        app.context({}),
      );
    expect(harness.activeJar.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("refuses a suspended account", async () => {
    await app.createUser({
      email: "suspended@example.com",
      password: "Correct-Horse-Battery-9",
      status: "suspended",
    });
    harness.resetCookies();
    const response = await login(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({
          email: "suspended@example.com",
          password: "Correct-Horse-Battery-9",
        }),
      }),
        app.context({}),
      );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(harness.activeJar.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects a malformed body rather than guessing", async () => {
    const response = await login(
      app.anonymous({ method: "POST", body: "{not json" }),
      app.context({}),
    );
    // Unparseable JSON is a bad request; a well-formed body that fails
    // validation is 422. Both are refusals, and neither guesses.
    expect(response.status).toBe(400);
    const body = await harness.errorBody(response);
    expect(body.error.code).toBe("invalid_json");
  });

  it("rejects a well-formed body that fails validation with 422", async () => {
    const response = await login(
      app.anonymous({ method: "POST", body: JSON.stringify({ email: 42 }) }),
      app.context({}),
    );
    expect(response.status).toBe(422);
  });

  it("never echoes the password back", async () => {
    await app.createUser({
      email: "echo@example.com",
      password: "Correct-Horse-Battery-9",
    });
    harness.resetCookies();
    const response = await login(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({
          email: "echo@example.com",
          password: "Correct-Horse-Battery-9",
        }),
      }),
        app.context({}),
      );
    expect(await response.text()).not.toContain("Correct-Horse-Battery-9");
  });
});

describe("GET /api/auth/session", () => {
  it("reports no session when the cookie is absent", async () => {
    const response = await getSession(
      app.anonymous({ method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { user: unknown; secondsRemaining: number };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.secondsRemaining).toBe(0);
  });

  it("reports the signed-in user", async () => {
    const id = await app.createUser({ email: "who@example.com", fullName: "Who Am I" });
    const response = await getSession(
      await app.as(id, { method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    const body = (await response.json()) as {
      data: {
        user: { email: string; fullName: string; role: string } | null;
        secondsRemaining: number;
      };
    };
    expect(body.data.user).not.toBeNull();
    expect(body.data.user!.email).toBe("who@example.com");
    expect(body.data.user!.role).toBe("analyst");
    expect(body.data.secondsRemaining).toBeGreaterThan(0);
  });

  it("rejects a tampered session cookie", async () => {
    const id = await app.createUser({ email: "tamper@example.com" });
    await app.signIn(id);
    const good = harness.activeJar.get(SESSION_COOKIE)!.value;
    harness.activeJar.set(SESSION_COOKIE, `${good.slice(0, -6)}AAAAAA`);

    const response = await getSession(
      app.anonymous({ method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    const body = (await response.json()) as {
      data: { user: unknown; secondsRemaining: number };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.secondsRemaining).toBe(0);
  });

  it("treats a revoked session as no session", async () => {
    const id = await app.createUser({ email: "revoked@example.com" });
    await app.signIn(id);
    await app.db.query("UPDATE sessions SET revoked_at = now()");

    const response = await getSession(
      app.anonymous({ method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    const body = (await response.json()) as {
      data: { user: unknown; secondsRemaining: number };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.secondsRemaining).toBe(0);
  });

  it("treats an expired session as no session", async () => {
    const id = await app.createUser({ email: "expired@example.com" });
    await app.signIn(id);
    // The table requires expires_at > created_at, so both have to move.
    await app.db.query(
      `UPDATE sessions
          SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'`,
    );

    const response = await getSession(
      app.anonymous({ method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    const body = (await response.json()) as {
      data: { user: unknown; secondsRemaining: number };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.secondsRemaining).toBe(0);
  });

  it("stops honouring sessions issued before a password change", async () => {
    const id = await app.createUser({ email: "rotated@example.com" });
    await app.signIn(id);
    // A password change bumps the user's epoch, which invalidates old sessions.
    await app.db.query("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1", [id]);

    const response = await getSession(
      app.anonymous({ method: "GET", url: "http://localhost/api/auth/session" }),
      app.context({}),
    );
    const body = (await response.json()) as {
      data: { user: unknown; secondsRemaining: number };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.secondsRemaining).toBe(0);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the cookie and revokes the session row", async () => {
    const id = await app.createUser({ email: "bye@example.com" });
    const request = await app.as(id, {
      method: "POST",
      url: "http://localhost/api/auth/logout",
    });

    const response = await logout(request, app.context({}));
    expect(response.status).toBeLessThan(400);
    expect(harness.activeJar.get(SESSION_COOKIE)).toBeUndefined();

    const sessions = await app.db.query<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM sessions WHERE user_id = $1",
      [id],
    );
    expect(sessions.rows.every((s) => s.revoked_at !== null)).toBe(true);
  });

  it("is safe to call with no session", async () => {
    const response = await logout(
      app.anonymous({ method: "POST", url: "http://localhost/api/auth/logout" }),
      app.context({}),
    );
    expect(response.status).toBeLessThan(400);
  });
});

describe("password reset", () => {
  it("does not reveal whether an address has an account", async () => {
    await app.createUser({ email: "known@example.com" });

    harness.resetCookies();
    const known = await forgotPassword(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({ email: "known@example.com" }),
      }),
        app.context({}),
      );
    const unknown = await forgotPassword(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({ email: "unknown@example.com" }),
      }),
        app.context({}),
      );

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("issues a single-use token that sets a new password", async () => {
    const id = await app.createUser({
      email: "reset@example.com",
      password: "Correct-Horse-Battery-9",
    });

    harness.resetCookies();
    await forgotPassword(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({ email: "reset@example.com" }),
      }),
        app.context({}),
      );

    const tokens = await app.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM password_reset_tokens WHERE user_id = $1",
      [id],
    );
    expect(tokens.rows).toHaveLength(1);

    // With the log email provider the link is written to the log rather than
    // sent, so the token is recovered from the stored hash by minting a known
    // one. What is being tested is the single-use and expiry behaviour.
    const plaintext = generateToken();
    await app.db.query(
      "UPDATE password_reset_tokens SET token_hash = $1 WHERE user_id = $2",
      [hashToken(plaintext), id],
    );

    const first = await resetPassword(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({ token: plaintext, password: "Brand-New-Password-7" }),
      }),
        app.context({}),
      );
    expect(first.status).toBeLessThan(400);

    // The same token cannot be used twice.
    harness.resetCookies();
    const second = await resetPassword(
      app.anonymous({
        method: "POST",
        body: JSON.stringify({ token: plaintext, password: "Another-Password-8" }),
      }),
        app.context({}),
      );
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});
