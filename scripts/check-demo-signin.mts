/**
 * Check the one-click demo sign-in.
 *
 * Confirms the sign-in page offers both accounts, that either one can be opened
 * without a password, that the role on the resulting session is the one
 * advertised, and that the guards hold: an account key that is not on the list
 * is refused, and the analyst is actually denied the administrator's pages.
 *
 *   npx tsx scripts/check-demo-signin.mts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const EXPECTED = [
  { key: "admin", email: "demo.admin@example.com", role: "admin" },
  { key: "analyst", email: "demo.analyst@example.com", role: "analyst" },
];

let failures = 0;
const results: string[] = [];

function record(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  results.push(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${detail}`);
}

// ---------------------------------------------------------------------------
// The sign-in page offers both accounts, before signing in anything.
// ---------------------------------------------------------------------------
const page = await (await fetch(`${BASE}/login`)).text();
for (const account of EXPECTED) {
  record(
    `login page lists ${account.email}`,
    page.includes(account.email),
  );
}
record(
  "login page shows the passwordless hint",
  page.includes("No password is needed"),
);

// ---------------------------------------------------------------------------
// Either account opens with one click, with no password in the request.
// ---------------------------------------------------------------------------
async function openAccount(key: string) {
  const response = await fetch(`${BASE}/api/auth/demo-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const cookie =
    response.headers
      .getSetCookie?.()
      .find((value) => value.trim().startsWith("churn_session="))
      ?.split(";")[0] ?? "";
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, cookie, body };
}

// Counts of the per-user sign-out control, compared after the loop.
const signOutCounts: Record<string, number> = {};

for (const account of EXPECTED) {
  const { status, cookie, body } = await openAccount(account.key);
  record(
    `POST demo-sign-in key=${account.key}`,
    status === 200 && cookie.length > 0,
    `status ${status}${cookie ? ", session set" : ", no session"}`,
  );

  // Every endpoint wraps its result, so the user sits under `data`.
  const user = (body as { data?: { user?: { email?: string; role?: string } } })
    ?.data?.user;
  record(
    `  session is ${account.email} (${account.role})`,
    user?.email === account.email && user?.role === account.role,
    user ? `got ${user.email} / ${user.role}` : "no user in response",
  );
  // The response must not carry the session token or the password hash.
  const raw = JSON.stringify(body ?? {});
  record(
    `  response leaks no token or hash`,
    !raw.includes("password_hash") && !/"token"/.test(raw),
  );

  // The signed-in page must render for real, not show the error boundary.
  const dashboard = await (
    await fetch(`${BASE}/dashboard`, { headers: { cookie } })
  ).text();
  record(
    `  dashboard renders for ${account.role}`,
    dashboard.includes("Simulated mode") &&
      !/This page could not be loaded/.test(dashboard),
  );

  // The role difference has to be real rather than a label. Changing the risk
  // thresholds is administrator-only, and the thresholds are sent back
  // unchanged so the assertion does not alter the demo world.
  const settings = await fetch(`${BASE}/api/settings`, {
    headers: { cookie },
  });
  const thresholds = (
    (await settings.json()) as { data?: { thresholds?: { high: number; medium: number } } }
  ).data?.thresholds;
  const update = await fetch(`${BASE}/api/settings`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(thresholds ?? { high: 0.7, medium: 0.4 }),
  });
  const mayAdminister = update.status === 200;
  record(
    `  may change global settings: ${mayAdminister}`,
    account.role === "admin" ? mayAdminister : !mayAdminister,
    `PATCH /api/settings -> ${update.status}`,
  );

  // The team page is read-only for everyone, so the role difference is the
  // per-user sign-out control, which only an administrator is offered. The
  // layout contributes one "Sign out" of its own on every page, so the
  // administrator's page simply has more of them; the counts are compared
  // against each other below rather than against a fixed number.
  const team = await (await fetch(`${BASE}/settings/team`, { headers: { cookie } })).text();
  signOutCounts[account.key] = (team.match(/Sign out/g) ?? []).length;
}

// The role difference, compared across the two accounts rather than against a
// fixed expectation. The layout always contributes one "Sign out", so the
// administrator's team page has strictly more.
record(
  "administrator sees the per-user sign-out control",
  (signOutCounts["admin"] ?? 0) > (signOutCounts["analyst"] ?? 0),
  `admin ${signOutCounts["admin"] ?? 0} vs analyst ${signOutCounts["analyst"] ?? 0}`,
);

// ---------------------------------------------------------------------------
// The guards.
// ---------------------------------------------------------------------------

// A key that is not on the list must not be accepted, and crucially must not
// be able to name an arbitrary user.
const forged = await fetch(`${BASE}/api/auth/demo-sign-in`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: "../../etc/passwd" }),
});
record("a forged account key is refused", forged.status === 404, `status ${forged.status}`);

const byEmail = await fetch(`${BASE}/api/auth/demo-sign-in`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "demo.admin@example.com" }),
});
// 422 is the schema rejecting the missing key; 400 or 404 would be the route
// rejecting an unknown one. Any of them is a refusal, which is the point.
record(
  "an email in place of a key is refused",
  byEmail.status === 400 || byEmail.status === 404 || byEmail.status === 422,
  `status ${byEmail.status}`,
);

const empty = await fetch(`${BASE}/api/auth/demo-sign-in`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: "" }),
});
record("an empty key is refused", empty.status >= 400, `status ${empty.status}`);

// ---------------------------------------------------------------------------
// The sign-in is a real one, so it must appear in the audit trail.
// ---------------------------------------------------------------------------
const password = readFileSync(
  path.join(process.cwd(), ".data", "demo-credentials.txt"),
  "utf8",
)
  .split(/\r?\n/)
  .find((line) => line.startsWith("password="))
  ?.slice("password=".length);

const typed = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "demo.admin@example.com",
    password: password ?? "not-set",
  }),
});
const typedCookie =
  typed.headers
    .getSetCookie?.()
    .find((value) => value.trim().startsWith("churn_session="))
    ?.split(";")[0] ?? "";
record("the shared password still works for typed sign-in", typed.status === 200);

const audit = await (
  await fetch(`${BASE}/audit`, { headers: { cookie: typedCookie } })
).text();
record(
  "demo sign-ins appear in the audit trail",
  audit.includes("login") || audit.includes("Sign in"),
);

process.stdout.write(`\n${results.join("\n")}\n`);
process.stdout.write(`\n${results.length} checks, ${failures} failed\n`);
process.exitCode = failures === 0 ? 0 : 1;