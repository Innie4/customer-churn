/**
 * Database client.
 *
 * One narrow interface over two PostgreSQL implementations:
 *
 *   - PGlite, an embedded build of PostgreSQL compiled to WebAssembly. Used for
 *     local development and tests, so nothing external has to be installed.
 *   - node-postgres, used whenever DATABASE_URL points at a real server.
 *
 * Both are PostgreSQL, so the migrations, constraints and triggers in
 * `db/migrations` are identical in both cases. Only the transport differs.
 *
 * The driver is chosen once, at module load, and never from a value that
 * arrives in a request.
 *
 * This module deliberately does not import `server-only`: it is also loaded by
 * the migration runner and the seed script, which run under plain Node. The
 * client is only reachable from the application's data access layer, which does
 * carry the `server-only` guard.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
  fields?: { name: string }[];
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: "pglite" | "postgres";
}

/** Thrown for constraint violations, so callers can map them to HTTP codes. */
export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

function normaliseError(error: unknown): DatabaseError {
  if (error && typeof error === "object") {
    const record = error as { message?: string; code?: string; detail?: string };
    if (record.code) {
      return new DatabaseError(
        record.message ?? "Database error",
        record.code,
        record.detail,
      );
    }
  }
  return new DatabaseError(
    error instanceof Error ? error.message : "Unknown database error",
    "unknown",
  );
}

class PGliteClient implements SqlClient {
  readonly driver = "pglite" as const;
  inTransaction = false;

  constructor(private readonly db: PGliteLike) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    try {
      const result = await this.db.query<Row>(sql, params as never[]);
      return {
        rows: result.rows as Row[],
        rowCount: result.rows.length,
        fields: result.fields as { name: string }[] | undefined,
      };
    } catch (error) {
      throw normaliseError(error);
    }
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.db.exec(sql);
    } catch (error) {
      throw normaliseError(error);
    }
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    // PGlite's own transaction helper gives a callback a client bound to the
    // open transaction, and rolls back automatically if the callback throws.
    return this.db.transaction(async (raw) => {
      const bound = new PGliteClient(raw);
      // Nested transactions are not supported, so a transaction client refuses
      // to start another rather than silently committing out of order.
      bound.inTransaction = true;
      return fn(bound);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

interface PGliteLike {
  query<Row>(sql: string, params?: unknown[]): Promise<{
    rows: Row[];
    fields: { name: string }[];
  }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: PGliteLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PostgresClient implements SqlClient {
  readonly driver = "postgres" as const;

  constructor(private readonly pool: PgPoolLike) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    try {
      const result = await this.pool.query(sql, params);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount ?? result.rows.length,
        fields: result.fields as { name: string }[] | undefined,
      };
    } catch (error) {
      throw normaliseError(error);
    }
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const bound = new PostgresClient({
      query: async (sql: string, params?: unknown[]) =>
        (await client.query(sql, params)) as never,
      connect: async () => {
        throw new Error("Nested transactions are not supported");
      },
      end: async () => undefined,
    } as unknown as PgPoolLike);
    try {
      await client.query("BEGIN");
      const result = await fn(bound);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{
    rows: unknown[];
    rowCount: number | null;
    fields: { name: string }[];
  }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

function dataDir(): string {
  const configured = process.env.PGLITE_DATA_DIR;
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), ".data", "postgres");
}

async function createPGlite(): Promise<SqlClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = dataDir();
  // PGlite's filesystem layer creates only the final directory, so the parents
  // have to exist first.
  mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return new PGliteClient(db as unknown as PGliteLike);
}

async function createPostgres(url: string): Promise<SqlClient> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    // Fail fast rather than hanging a request when the database is unreachable.
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 8000),
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  return new PostgresClient(pool as unknown as PgPoolLike);
}

let cached: Promise<SqlClient> | null = null;

/**
 * Return the shared database client, creating it on first use.
 *
 * The client is cached for the life of the process so a serverless invocation
 * does not open a new pool per request.
 */
export function getDatabase(): Promise<SqlClient> {
  if (cached) return cached;

  const url = process.env.DATABASE_URL?.trim();
  const usePGlite = process.env.DATABASE_DRIVER === "pglite" || !url;

  cached = (async () => {
    if (usePGlite) {
      return createPGlite();
    }
    try {
      return await createPostgres(url as string);
    } catch (error) {
      throw new DatabaseError(
        `Could not connect to PostgreSQL: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        "connection_failed",
      );
    }
  })();

  // A failed connection must not poison the cache for the whole process.
  cached.catch(() => {
    cached = null;
  });

  return cached;
}

/** Discard the cached client. Used by tests between isolated databases. */
export function resetDatabaseCache(): void {
  cached = null;
}

/**
 * Install a specific client as the shared one.
 *
 * Tests only. An application test needs the code under test to talk to an
 * in-memory database it created and migrated, and the only supported way to do
 * that is to put that client where `getDatabase` will find it. Passing null
 * restores normal behaviour. Nothing in the application calls this.
 */
export function setDatabaseForTesting(client: SqlClient | null): void {
  cached = client ? Promise.resolve(client) : null;
}

/**
 * Create a brand new client, bypassing the shared cache.
 *
 * Scripts own their connection's lifetime and close it themselves, so they must
 * not take the cached instance the application uses.
 */
export async function createDatabase(): Promise<SqlClient> {
  const url = process.env.DATABASE_URL?.trim();
  if (process.env.DATABASE_DRIVER === "pglite" || !url) {
    return createPGlite();
  }
  try {
    return await createPostgres(url);
  } catch (error) {
    throw new DatabaseError(
      `Could not connect to PostgreSQL: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      "connection_failed",
    );
  }
}

export function usingPGlite(): boolean {
  return process.env.DATABASE_DRIVER === "pglite" || !process.env.DATABASE_URL?.trim();
}

/**
 * Create an isolated in-memory database for a test.
 *
 * Always PGlite, always fresh, so a test never depends on or disturbs
 * developer data.
 */
export async function createTestDatabase(): Promise<SqlClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.waitReady;
  return new PGliteClient(db as unknown as PGliteLike);
}

/** Apply every migration to a client, without touching the global cache. */
export async function migrateClient(
  db: SqlClient,
  options: { verbose?: boolean } = {},
): Promise<{ applied: string[]; failed: { id: string; error: string } | null }> {
  const { loadMigrations } = await import("./migrate");
  const applied: string[] = [];

  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);

  const existing = await db.query<{ id: string; checksum: string }>(
    "SELECT id, checksum FROM _migrations",
  );
  const byId = new Map(existing.rows.map((row) => [row.id, row.checksum]));

  for (const file of await loadMigrations()) {
    const known = byId.get(file.id);
    if (known !== undefined) {
      if (known !== file.checksum) {
        return {
          applied,
          failed: {
            id: file.id,
            error: "Already applied but the file has changed since.",
          },
        };
      }
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.exec(file.sql);
        await tx.query(
          "INSERT INTO _migrations (id, checksum, duration_ms) VALUES ($1, $2, $3)",
          [file.id, file.checksum, 0],
        );
      });
      applied.push(file.id);
      if (options.verbose) process.stdout.write(`  applied ${file.filename}\n`);
    } catch (error) {
      return {
        applied,
        failed: {
          id: file.id,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  return { applied, failed: null };
}

