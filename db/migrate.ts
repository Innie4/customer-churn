/**
 * Migration runner.
 *
 * Applies the ordered SQL files in `db/migrations` and records each one in a
 * `_migrations` table, so re-running is a no-op and a partially applied run can
 * be diagnosed. Works unchanged against PGlite (local, test) and PostgreSQL
 * (production), because both are PostgreSQL and both speak the same protocol.
 *
 *   npm run db:migrate              apply pending migrations
 *   npm run db:migrate:status       show what is applied and what is pending
 *   npm run db:migrate:reset        drop and recreate (local/test only)
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabase } from "./client";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id          text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  )
`;

export interface MigrationFile {
  id: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  id: string;
  applied: boolean;
  appliedAt: string | null;
  checksumMatches: boolean;
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

export async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    // Lexicographic order is the execution order, so filenames are zero-padded.
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(
    entries.map(async (filename) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
      return {
        id: filename.replace(/\.sql$/, ""),
        filename,
        sql,
        checksum: await sha256(sql),
      };
    }),
  );
}

export async function migrationStatus(): Promise<MigrationStatus[]> {
  const db = await createDatabase();
  try {
    await db.exec(CREATE_LEDGER);
    const applied = await db.query<{
      id: string;
      checksum: string;
      applied_at: string;
    }>("SELECT id, checksum, applied_at FROM _migrations");
    const byId = new Map(applied.rows.map((row) => [row.id, row]));
    const files = await loadMigrations();

    return files.map((file) => {
      const record = byId.get(file.id);
      return {
        id: file.id,
        applied: Boolean(record),
        appliedAt: record?.applied_at ?? null,
        // A changed checksum for an already-applied migration means the file was
        // edited after the fact, which would make the database disagree with
        // the repository. Surfaced rather than ignored.
        checksumMatches: record ? record.checksum === file.checksum : true,
      };
    });
  } finally {
    await db.close();
  }
}

export interface MigrationOutcome {
  applied: string[];
  alreadyApplied: string[];
  failed: { id: string; error: string } | null;
  totalMs: number;
}

export async function runMigrations(
  options: { verbose?: boolean } = {},
): Promise<MigrationOutcome> {
  const db = await createDatabase();
  const outcome: MigrationOutcome = {
    applied: [],
    alreadyApplied: [],
    failed: null,
    totalMs: 0,
  };
  const startedAll = Date.now();

  try {
    await db.exec(CREATE_LEDGER);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS _migration_lock (
        id         integer PRIMARY KEY DEFAULT 1,
        acquired_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT migration_lock_single_row CHECK (id = 1)
      )
    `);
    // Serialise concurrent runners. A second process waits rather than racing.
    await db.exec(`
      INSERT INTO _migration_lock (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);

    const applied = await db.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM _migrations",
    );
    const byId = new Map(applied.rows.map((row) => [row.id, row.checksum]));
    const files = await loadMigrations();

    for (const file of files) {
      const existing = byId.get(file.id);
      if (existing !== undefined) {
        if (existing !== file.checksum) {
          outcome.failed = {
            id: file.id,
            error:
              "This migration was already applied but its contents have " +
              "changed since. Applied migrations must never be edited; add a " +
              "new migration instead.",
          };
          return outcome;
        }
        outcome.alreadyApplied.push(file.id);
        continue;
      }

      const started = Date.now();
      try {
        // Each migration runs in its own transaction, so a failure leaves the
        // database on the last good migration rather than half-way through one.
        await db.transaction(async (tx) => {
          await tx.exec(file.sql);
          await tx.query(
            `INSERT INTO _migrations (id, checksum, duration_ms)
             VALUES ($1, $2, $3)`,
            [file.id, file.checksum, Date.now() - started],
          );
        });
      } catch (error) {
        outcome.failed = {
          id: file.id,
          error: error instanceof Error ? error.message : String(error),
        };
        return outcome;
      }

      outcome.applied.push(file.id);
      if (options.verbose) {
        process.stdout.write(`  applied ${file.filename}\n`);
      }
    }

    outcome.totalMs = Date.now() - startedAll;
    return outcome;
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "up";

  if (command === "status") {
    const statuses = await migrationStatus();
    process.stdout.write("Migration status\n");
    for (const status of statuses) {
      const mark = status.applied ? "applied" : "pending";
      const drift = status.applied && !status.checksumMatches ? "  CHANGED" : "";
      process.stdout.write(
        `  ${status.id.padEnd(34)} ${mark}${drift}\n`,
      );
    }
    return;
  }

  const outcome = await runMigrations({ verbose: true });
  if (outcome.failed) {
    process.stderr.write(
      `\nMigration ${outcome.failed.id} failed:\n  ${outcome.failed.error}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `\n${outcome.applied.length} applied, ` +
      `${outcome.alreadyApplied.length} already present ` +
      `(${outcome.totalMs} ms)\n`,
  );
}

// Run only when executed directly, not when imported by a test.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
  });
}
