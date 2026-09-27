/**
 * Post-seed check: confirm the seeded admin can authenticate and that the
 * strategy library landed in a valid state.
 *
 *   npx tsx scripts/verify-seed.ts
 */

import { verifyPasswordHash } from "../src/lib/auth/crypto";
import { createDatabase } from "../db/client";

const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Temp-Passw0rd!x9";

async function main() {
  const db = await createDatabase();
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (!ok) failures += 1;
    process.stdout.write(
      `  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}\n`,
    );
  };

  try {
    const users = await db.query<{ email: string; password_hash: string }>(
      "SELECT email, password_hash FROM users ORDER BY email",
    );
    process.stdout.write(`Users (${users.rows.length})\n`);
    for (const user of users.rows) {
      const good = await verifyPasswordHash(PASSWORD, user.password_hash);
      const bad = await verifyPasswordHash("definitely-not-the-password", user.password_hash);
      check(`${user.email} accepts its password`, good);
      check(`${user.email} rejects a wrong password`, bad === false);
    }

    const strategies = await db.query<{
      title: string;
      status: string;
      risk_driver: string;
      priority: string;
    }>("SELECT title, status, risk_driver, priority FROM retention_strategies ORDER BY priority DESC, title");
    process.stdout.write(`Strategies (${strategies.rows.length})\n`);
    for (const s of strategies.rows) {
      process.stdout.write(
        `        ${s.status.padEnd(9)} ${s.priority.padEnd(8)} ${s.risk_driver}\n`,
      );
    }
    check("strategy library is populated", strategies.rows.length > 0);
    check(
      "no strategy is approved without a recorded approver",
      strategies.rows.every((s) => s.status !== "approved"),
      "the seed must not fabricate a human approval",
    );

    const audit = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs",
    );
    process.stdout.write(`Audit rows: ${audit.rows[0]?.n}\n`);
    check("seed activity was audited", Number(audit.rows[0]?.n ?? 0) > 0);
  } finally {
    await db.close();
  }

  process.stdout.write(
    failures === 0 ? "\nAll seed checks passed.\n" : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
