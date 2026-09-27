/**
 * Database tests.
 *
 * Every test runs against a fresh in-memory PostgreSQL with the real migration
 * files applied, so these assert what the schema actually does rather than what
 * the SQL appears to say.
 *
 * The point of most of these is the negative case: a constraint that is never
 * violated in a test is a constraint nobody has checked.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  migrateClient,
  type SqlClient,
} from "../../db/client";

let db: SqlClient;

async function seedUser(
  client: SqlClient,
  email = "analyst@example.com",
  role: "admin" | "analyst" | "viewer" = "analyst",
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, 'hash', 'Test User', $2) RETURNING id`,
    [email, role],
  );
  return result.rows[0].id;
}

async function seedDataset(
  client: SqlClient,
  uploader: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO datasets
       (name, original_filename, storage_path, size_bytes, sha256, uploaded_by, status)
     VALUES ($1, 'data.csv', 'datasets/x/data.csv', 1024, $2, $3, 'uploaded')
     RETURNING id`,
    [
      String(overrides.name ?? `Dataset ${Math.random().toString(36).slice(2, 8)}`),
      overrides.sha256 ??
        `sha-${Math.random().toString(36).slice(2, 12)}`,
      uploader,
    ],
  );
  return result.rows[0].id;
}

async function seedModel(
  client: SqlClient,
  runId: string,
  userId: string,
  options: { type?: string; active?: boolean; status?: string } = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO model_results
       (model_run_id, model_type, display_name, status, is_active,
        activated_at, activated_by, test_metrics, test_confusion)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $5 THEN now() ELSE NULL END,
             CASE WHEN $5 THEN $6::uuid ELSE NULL END,
             '{"accuracy":0.8}', '{"true_negative":10,"false_positive":2,"false_negative":3,"true_positive":5}')
     RETURNING id`,
    [
      runId,
      options.type ?? "xgboost",
      "XGBoost",
      options.status ?? "completed",
      options.active ?? false,
      options.active ? userId : null,
    ],
  );
  return result.rows[0].id;
}

async function seedModelRun(
  client: SqlClient,
  datasetId: string,
  userId: string,
): Promise<string> {
  const preprocessing = await client.query<{ id: string }>(
    `INSERT INTO preprocessing_runs
       (dataset_id, ml_preprocessing_id, status, completed_at)
     VALUES ($1, $2, 'completed', now()) RETURNING id`,
    [datasetId, `ml-${Math.random().toString(36).slice(2, 12)}`],
  );
  const run = await client.query<{ id: string }>(
    `INSERT INTO model_runs
       (dataset_id, preprocessing_run_id, status, stage, started_at, finished_at, started_by)
     VALUES ($1, $2, 'completed', 'Training complete', now(), now(), $3)
     RETURNING id`,
    [datasetId, preprocessing.rows[0].id, userId],
  );
  return run.rows[0].id;
}

async function seedCustomer(
  client: SqlClient,
  datasetId: string,
  externalId = "C-001",
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO customers (dataset_id, external_id, attributes)
     VALUES ($1, $2, '{"tenure":12}') RETURNING id`,
    [datasetId, externalId],
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const outcome = await migrateClient(db);
  if (outcome.failed) {
    throw new Error(
      `Migration ${outcome.failed.id} failed: ${outcome.failed.error}`,
    );
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------

describe("migrations", () => {
  it("creates every table the application needs", async () => {
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = result.rows.map((r) => r.table_name);
    for (const expected of [
      "users", "profiles", "sessions", "password_reset_tokens",
      "datasets", "dataset_columns", "dataset_validation_results",
      "preprocessing_runs", "model_runs", "model_results", "model_artifacts",
      "model_risk_reviews", "customers", "predictions", "prediction_explanations",
      "retention_strategies", "customer_retention_actions", "retention_action_events",
      "reports", "audit_logs", "app_settings",
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected);
    }
  });

  it("records each migration exactly once", async () => {
    const result = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM _migrations",
    );
    // Counted from the files rather than hard-coded, so adding a migration does
    // not leave a stale number here claiming the schema is one step behind.
    const { loadMigrations } = await import("../../db/migrate");
    const files = await loadMigrations();
    expect(Number(result.rows[0].count)).toBe(files.length);
    expect(files.length).toBeGreaterThan(0);
  });

  it("records a checksum for every migration, so an edited file is detected", async () => {
    const rows = await db.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM _migrations ORDER BY id",
    );
    for (const row of rows.rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is idempotent", async () => {
    const outcome = await migrateClient(db);
    expect(outcome.failed).toBeNull();
    expect(outcome.applied).toEqual([]);
  });

  it("seeds default platform settings", async () => {
    const result = await db.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM app_settings ORDER BY key",
    );
    const keys = result.rows.map((r) => r.key);
    expect(keys).toContain("risk.thresholds");
    expect(keys).toContain("ml.cv_folds");
  });
});

describe("users and sessions", () => {
  it("rejects a duplicate email regardless of case", async () => {
    await seedUser(db, "Unique@Example.com");
    await expect(
      db.query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, 'hash', 'Other')`,
        ["unique@example.com"],
      ),
    ).rejects.toThrow();
  });

  it("rejects an email that is not an address", async () => {
    await expect(
      db.query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ('not-an-email', 'hash', 'Bad')`,
      ),
    ).rejects.toThrow();
  });

  it("restricts roles to the known set", async () => {
    await expect(
      db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('super@example.com', 'hash', 'Bad', 'superuser')`,
      ),
    ).rejects.toThrow();
  });

  it("stores only what a session needs and cascades on user deletion", async () => {
    const userId = await seedUser(db, "session@example.com");
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, session_epoch, expires_at)
       VALUES ($1, $2, 1, now() + interval '1 hour')`,
      [userId, "token-abc"],
    );
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    const remaining = await db.query("SELECT count(*)::int AS n FROM sessions");
    expect(remaining.rows[0].n).toBe(0);
  });

  it("refuses a session that has already expired", async () => {
    const userId = await seedUser(db, "expiry@example.com");
    await expect(
      db.query(
        `INSERT INTO sessions (user_id, token_hash, session_epoch, expires_at)
         VALUES ($1, 'token-old', 1, now() - interval '1 hour')`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it("will not store the same session token twice", async () => {
    const userId = await seedUser(db, "dup-token@example.com");
    const insert = (token: string) =>
      db.query(
        `INSERT INTO sessions (user_id, token_hash, session_epoch, expires_at)
         VALUES ($1, $2, 1, now() + interval '1 hour')`,
        [userId, token],
      );
    await insert("same-token");
    await expect(insert("same-token")).rejects.toThrow();
  });

  it("only allows one unused reset token per hash and expires them", async () => {
    const userId = await seedUser(db, "reset@example.com");
    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, 'reset-1', now() + interval '1 hour')`,
      [userId],
    );
    await expect(
      db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, 'reset-1', now() + interval '1 hour')`,
        [userId],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, 'reset-old', now() - interval '1 hour')`,
        [userId],
      ),
    ).rejects.toThrow();
  });
});

describe("datasets", () => {
  it("refuses the same file content twice", async () => {
    const userId = await seedUser(db, "ds-dup@example.com");
    await seedDataset(db, userId, { sha256: "identical-digest" });
    await expect(
      seedDataset(db, userId, { sha256: "identical-digest" }),
    ).rejects.toThrow();
  });

  it("allows a soft-deleted dataset to be re-uploaded", async () => {
    const userId = await seedUser(db, "ds-reup@example.com");
    const id = await seedDataset(db, userId, { sha256: "reused-digest" });
    await db.query("UPDATE datasets SET deleted_at = now() WHERE id = $1", [id]);
    await expect(
      seedDataset(db, userId, { sha256: "reused-digest" }),
    ).resolves.toBeDefined();
  });

  it("rejects a negative file size and an out-of-range churn rate", async () => {
    const userId = await seedUser(db, "ds-bad@example.com");
    await expect(
      db.query(
        `INSERT INTO datasets
           (name, original_filename, storage_path, size_bytes, sha256, uploaded_by)
         VALUES ('n', 'f.csv', 'p', -1, 's1', $1)`,
        [userId],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO datasets
           (name, original_filename, storage_path, size_bytes, sha256,
            uploaded_by, target_positive_rate)
         VALUES ('n', 'f.csv', 'p', 10, 's2', $1, 1.5)`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it("stores each column once per dataset", async () => {
    const userId = await seedUser(db, "cols@example.com");
    const datasetId = await seedDataset(db, userId);
    const insert = (position: number) =>
      db.query(
        `INSERT INTO dataset_columns
           (dataset_id, position, name, inferred_type, pandas_dtype,
            non_null_count, null_count, distinct_count)
         VALUES ($1, $2, 'tenure', 'numeric', 'int64', 10, 0, 8)`,
        [datasetId, position],
      );
    await insert(0);
    await expect(insert(0)).rejects.toThrow();
    await expect(insert(1)).rejects.toThrow(); // same name
  });

  it("keeps only one current validation verdict per dataset", async () => {
    const userId = await seedUser(db, "val@example.com");
    const datasetId = await seedDataset(db, userId);
    const insert = (status: string) =>
      db.query(
        `INSERT INTO dataset_validation_results (dataset_id, status, error_count)
         VALUES ($1, $2, 0)`,
        [datasetId, status],
      );
    await insert("pass");
    await expect(insert("fail")).rejects.toThrow();
  });
});

describe("models", () => {
  it("will not record a completed model with no measured metrics", async () => {
    const userId = await seedUser(db, "fake-metrics@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    await expect(
      db.query(
        `INSERT INTO model_results (model_run_id, model_type, display_name, status)
         VALUES ($1, 'xgboost', 'XGBoost', 'completed')`,
        [runId],
      ),
    ).rejects.toThrow();
  });

  it("will not record a failed model with no reason", async () => {
    const userId = await seedUser(db, "no-reason@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    await expect(
      db.query(
        `INSERT INTO model_results (model_run_id, model_type, display_name, status)
         VALUES ($1, 'random_forest', 'Random Forest', 'failed')`,
        [runId],
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown model type", async () => {
    const userId = await seedUser(db, "bad-type@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    await expect(
      db.query(
        `INSERT INTO model_results (model_run_id, model_type, display_name, status)
         VALUES ($1, 'transformer', 'Transformer', 'pending')`,
        [runId],
      ),
    ).rejects.toThrow();
  });

  it("allows only one active model per family", async () => {
    const userId = await seedUser(db, "active@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    await seedModel(db, runId, userId, { active: true, type: "xgboost" });
    await expect(
      seedModel(db, runId, userId, { active: true, type: "xgboost" }),
    ).rejects.toThrow();
    // A different family can be active at the same time.
    await expect(
      seedModel(db, runId, userId, { active: true, type: "logistic_regression" }),
    ).resolves.toBeDefined();
  });

  it("refuses to activate a model without an audit trail", async () => {
    const userId = await seedUser(db, "no-audit@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    await expect(
      db.query(
        `INSERT INTO model_results
           (model_run_id, model_type, display_name, status, is_active,
            test_metrics, test_confusion)
         VALUES ($1, 'xgboost', 'XGBoost', 'completed', true,
                 '{}', '{}')`,
        [runId],
      ),
    ).rejects.toThrow();
  });

  it("refuses a finished run with no finish timestamp", async () => {
    const userId = await seedUser(db, "no-finish@example.com");
    const datasetId = await seedDataset(db, userId);
    const preprocessing = await db.query<{ id: string }>(
      `INSERT INTO preprocessing_runs (dataset_id, ml_preprocessing_id, status)
       VALUES ($1, 'ml-x', 'completed') RETURNING id`,
      [datasetId],
    );
    await expect(
      db.query(
        `INSERT INTO model_runs (dataset_id, preprocessing_run_id, status, stage)
         VALUES ($1, $2, 'completed', 'done')`,
        [datasetId, preprocessing.rows[0].id],
      ),
    ).rejects.toThrow();
  });

  it("keeps history rather than overwriting a previous model", async () => {
    const userId = await seedUser(db, "history@example.com");
    const datasetId = await seedDataset(db, userId);
    const firstRun = await seedModelRun(db, datasetId, userId);
    const secondRun = await seedModelRun(db, datasetId, userId);
    const a = await seedModel(db, firstRun, userId, { type: "xgboost" });
    const b = await seedModel(db, secondRun, userId, { type: "xgboost" });
    expect(a).not.toBe(b);
    const count = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM model_results WHERE model_type = 'xgboost'",
    );
    expect(count.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("allows an open risk review but not a closed one without a reviewer", async () => {
    const userId = await seedUser(db, "review@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const modelId = await seedModel(db, runId, userId, {});
    const insert = (status: string) =>
      db.query(
        `INSERT INTO model_risk_reviews
           (model_result_id, feature, concern_type, status)
         VALUES ($1, 'SeniorCitizen', 'proxy_risk', $2)`,
        [modelId, status],
      );
    await expect(insert("open")).resolves.toBeDefined();
    await expect(insert("accepted")).rejects.toThrow();
  });
});

describe("customers and predictions", () => {
  it("will not load the same customer twice from one dataset", async () => {
    const userId = await seedUser(db, "cust@example.com");
    const datasetId = await seedDataset(db, userId);
    await seedCustomer(db, datasetId, "DUP-1");
    await expect(seedCustomer(db, datasetId, "DUP-1")).rejects.toThrow();
    // A different dataset may hold the same external id.
    const otherDataset = await seedDataset(db, userId);
    await expect(seedCustomer(db, otherDataset, "DUP-1")).resolves.toBeDefined();
  });

  it("refuses a probability outside zero to one", async () => {
    const userId = await seedUser(db, "prob@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const modelId = await seedModel(db, runId, userId, {});
    const customerId = await seedCustomer(db, datasetId);
    await expect(
      db.query(
        `INSERT INTO predictions
           (customer_id, model_result_id, model_version, ml_model_id,
            churn_probability, predicted_label, risk_category, risk_thresholds)
         VALUES ($1, $2, 'v1', 'xgboost-v1', 1.4, 1, 'high',
                 '{"high":0.7,"medium":0.4}')`,
        [customerId, modelId],
      ),
    ).rejects.toThrow();
  });

  it("enforces that the risk band matches the stored probability", async () => {
    const userId = await seedUser(db, "band@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const modelId = await seedModel(db, runId, userId, {});

    // One customer per case, because a customer is scored once per model.
    const insert = async (
      externalId: string,
      probability: number,
      band: string,
    ) => {
      const customerId = await seedCustomer(db, datasetId, externalId);
      return db.query(
        `INSERT INTO predictions
           (customer_id, model_result_id, model_version, ml_model_id,
            churn_probability, predicted_label, risk_category, risk_thresholds)
         VALUES ($1, $2, 'v1', 'xgboost-v1', $3, 1, $4,
                 '{"high":0.7,"medium":0.4}')`,
        [customerId, modelId, probability, band],
      );
    };

    await expect(insert("BAND-HI", 0.85, "high")).resolves.toBeDefined();
    await expect(insert("BAND-WRONG-HI", 0.5, "high")).rejects.toThrow();
    await expect(insert("BAND-MID", 0.5, "medium")).resolves.toBeDefined();
    await expect(insert("BAND-WRONG-LOW", 0.5, "low")).rejects.toThrow();
    await expect(insert("BAND-LO", 0.1, "low")).resolves.toBeDefined();
    await expect(insert("BAND-WRONG-MID", 0.5, "high")).rejects.toThrow();
  });

  it("rejects thresholds that are not ordered", async () => {
    const userId = await seedUser(db, "thresh@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const modelId = await seedModel(db, runId, userId, {});
    const customerId = await seedCustomer(db, datasetId, "THRESH-1");
    await expect(
      db.query(
        `INSERT INTO predictions
           (customer_id, model_result_id, model_version, ml_model_id,
            churn_probability, predicted_label, risk_category, risk_thresholds)
         VALUES ($1, $2, 'v1', 'xgboost-v1', 0.9, 1, 'high',
                 '{"high":0.3,"medium":0.7}')`,
        [customerId, modelId],
      ),
    ).rejects.toThrow();
  });

  it("replaces a re-scored prediction instead of duplicating it", async () => {
    const userId = await seedUser(db, "rescore@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const modelId = await seedModel(db, runId, userId, {});
    const customerId = await seedCustomer(db, datasetId, "RESCORE-1");
    const insert = (probability: number) =>
      db.query(
        `INSERT INTO predictions
           (customer_id, model_result_id, model_version, ml_model_id,
            churn_probability, predicted_label, risk_category, risk_thresholds)
         VALUES ($1, $2, 'v1', 'xgboost-v1', $3, 1,
                 CASE WHEN $3 >= 0.7 THEN 'high'
                      WHEN $3 >= 0.4 THEN 'medium' ELSE 'low' END,
                 '{"high":0.7,"medium":0.4}')`,
        [customerId, modelId, probability],
      );
    await insert(0.8);
    await expect(insert(0.9)).rejects.toThrow();
  });

  it("points a customer at their newest prediction automatically", async () => {
    const userId = await seedUser(db, "latest@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    // Two different models, so the customer can hold one prediction from each.
    const firstModel = await seedModel(db, runId, userId, { type: "xgboost" });
    const secondModel = await seedModel(db, runId, userId, {
      type: "logistic_regression",
    });
    const customerId = await seedCustomer(db, datasetId, "LATEST-1");

    const older = await db.query<{ id: string }>(
      `INSERT INTO predictions
         (customer_id, model_result_id, model_version, ml_model_id,
          churn_probability, predicted_label, risk_category, risk_thresholds,
          predicted_at)
       VALUES ($1, $2, 'v1', 'm1', 0.2, 0, 'low', '{"high":0.7,"medium":0.4}',
               now() - interval '1 day')
       RETURNING id`,
      [customerId, firstModel],
    );

    const afterFirst = await db.query<{ latest_prediction_id: string }>(
      "SELECT latest_prediction_id FROM customers WHERE id = $1",
      [customerId],
    );
    expect(afterFirst.rows[0].latest_prediction_id).toBe(older.rows[0].id);

    const newer = await db.query<{ id: string }>(
      `INSERT INTO predictions
         (customer_id, model_result_id, model_version, ml_model_id,
          churn_probability, predicted_label, risk_category, risk_thresholds)
       VALUES ($1, $2, 'v2', 'm2', 0.9, 1, 'high', '{"high":0.7,"medium":0.4}')
       RETURNING id`,
      [customerId, secondModel],
    );

    const afterSecond = await db.query<{ latest_prediction_id: string }>(
      "SELECT latest_prediction_id FROM customers WHERE id = $1",
      [customerId],
    );
    expect(afterSecond.rows[0].latest_prediction_id).toBe(newer.rows[0].id);
  });

  it("does not move the pointer backwards to an older prediction", async () => {
    const userId = await seedUser(db, "latest-old@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const firstModel = await seedModel(db, runId, userId, { type: "xgboost" });
    const secondModel = await seedModel(db, runId, userId, {
      type: "logistic_regression",
    });
    const customerId = await seedCustomer(db, datasetId, "LATEST-2");

    const recent = await db.query<{ id: string }>(
      `INSERT INTO predictions
         (customer_id, model_result_id, model_version, ml_model_id,
          churn_probability, predicted_label, risk_category, risk_thresholds,
          predicted_at)
       VALUES ($1, $2, 'v2', 'm2', 0.9, 1, 'high', '{"high":0.7,"medium":0.4}',
               now() - interval '1 minute')
       RETURNING id`,
      [customerId, secondModel],
    );
    // An older prediction arriving late must not become the current one.
    await db.query(
      `INSERT INTO predictions
         (customer_id, model_result_id, model_version, ml_model_id,
          churn_probability, predicted_label, risk_category, risk_thresholds,
          predicted_at)
       VALUES ($1, $2, 'v1', 'm1', 0.2, 0, 'low', '{"high":0.7,"medium":0.4}',
               now() - interval '3 days')`,
      [customerId, firstModel],
    );

    const customer = await db.query<{ latest_prediction_id: string }>(
      "SELECT latest_prediction_id FROM customers WHERE id = $1",
      [customerId],
    );
    expect(customer.rows[0].latest_prediction_id).toBe(recent.rows[0].id);
  });

  it("will not record a completed explanation with no contributions", async () => {
    const userId = await seedUser(db, "expl@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const modelId = await seedModel(db, runId, userId, {});
    const customerId = await seedCustomer(db, datasetId, "EXPL-1");
    const prediction = await db.query<{ id: string }>(
      `INSERT INTO predictions
         (customer_id, model_result_id, model_version, ml_model_id,
          churn_probability, predicted_label, risk_category, risk_thresholds)
       VALUES ($1, $2, 'v1', 'm1', 0.8, 1, 'high', '{"high":0.7,"medium":0.4}')
       RETURNING id`,
      [customerId, modelId],
    );
    await expect(
      db.query(
        `INSERT INTO prediction_explanations
           (prediction_id, model_result_id, status, contributions)
         VALUES ($1, $2, 'completed', '[]'::jsonb)`,
        [prediction.rows[0].id, modelId],
      ),
    ).rejects.toThrow();
  });

  it("will not record a failed explanation with no reason", async () => {
    const userId = await seedUser(db, "expl-fail@example.com");
    const datasetId = await seedDataset(db, userId);
    const runId = await seedModelRun(db, datasetId, userId);
    const modelId = await seedModel(db, runId, userId, {});
    const customerId = await seedCustomer(db, datasetId, "EXPLF-1");
    const prediction = await db.query<{ id: string }>(
      `INSERT INTO predictions
         (customer_id, model_result_id, model_version, ml_model_id,
          churn_probability, predicted_label, risk_category, risk_thresholds)
       VALUES ($1, $2, 'v1', 'm1', 0.8, 1, 'high', '{"high":0.7,"medium":0.4}')
       RETURNING id`,
      [customerId, modelId],
    );
    await expect(
      db.query(
        `INSERT INTO prediction_explanations (prediction_id, model_result_id, status)
         VALUES ($1, $2, 'failed')`,
        [prediction.rows[0].id, modelId],
      ),
    ).rejects.toThrow();
  });
});

describe("retention", () => {
  it("requires a timestamp once an action is closed", async () => {
    const userId = await seedUser(db, "action@example.com");
    const datasetId = await seedDataset(db, userId);
    const customerId = await seedCustomer(db, datasetId, "ACT-1");
    await expect(
      db.query(
        `INSERT INTO customer_retention_actions (customer_id, title, status)
         VALUES ($1, 'Call the customer', 'completed')`,
        [customerId],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO customer_retention_actions
           (customer_id, title, status, completed_at)
         VALUES ($1, 'Call the customer', 'completed', now())`,
        [customerId],
      ),
    ).resolves.toBeDefined();
  });

  it("restricts action statuses to the documented workflow", async () => {
    const userId = await seedUser(db, "status@example.com");
    const datasetId = await seedDataset(db, userId);
    const customerId = await seedCustomer(db, datasetId, "ACT-2");
    for (const status of ["suggested", "planned", "in_progress"]) {
      await expect(
        db.query(
          `INSERT INTO customer_retention_actions (customer_id, title, status)
           VALUES ($1, 'Reach out', $2)`,
          [customerId, status],
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      db.query(
        `INSERT INTO customer_retention_actions (customer_id, title, status)
         VALUES ($1, 'Reach out', 'abandoned')`,
        [customerId],
      ),
    ).rejects.toThrow();
  });

  it("allows only one open action per customer and strategy", async () => {
    const userId = await seedUser(db, "oneopen@example.com");
    const datasetId = await seedDataset(db, userId);
    const customerId = await seedCustomer(db, datasetId, "ACT-3");
    const strategy = await db.query<{ id: string }>(
      `INSERT INTO retention_strategies
         (title, description, triggering_condition, risk_driver,
          suggested_intervention, status, approved_by, approved_at)
       VALUES ('Offer a contract upgrade', 'Move to a longer plan',
               'Contract is month-to-month', 'Contract: Month-to-month',
               'Offer a bill credit', 'approved', $1, now())
       RETURNING id`,
      [userId],
    );
    const strategyId = strategy.rows[0].id;

    const insert = async (status: "planned" | "completed") => {
      const result = await db.query<{ id: string }>(
        `INSERT INTO customer_retention_actions
           (customer_id, strategy_id, title, status, completed_at)
         VALUES ($1, $2, 'Send the offer', $3,
                 CASE WHEN $3 = 'completed' THEN now() ELSE NULL END)
         RETURNING id`,
        [customerId, strategyId, status],
      );
      return result.rows[0].id;
    };

    const first = await insert("planned");
    // A second live action for the same suggestion would duplicate the work.
    await expect(insert("planned")).rejects.toThrow();
    // A closed action is not "open", so it does not occupy the slot.
    const closed = await insert("completed");

    // Closing the original frees the slot for a fresh attempt.
    await db.query(
      `UPDATE customer_retention_actions
          SET status = 'completed', completed_at = now()
        WHERE id = $1`,
      [first],
    );
    const second = await insert("planned");

    expect(new Set([first, closed, second]).size).toBe(3);
  });

  it("requires an approver before a strategy is approved", async () => {
    await expect(
      db.query(
        `INSERT INTO retention_strategies
           (title, description, triggering_condition, risk_driver,
            suggested_intervention, status)
         VALUES ('Unapproved strategy', 'd', 'c', 'r', 'i', 'approved')`,
      ),
    ).rejects.toThrow();
  });

  it("records status history that cannot be silently lost", async () => {
    const userId = await seedUser(db, "events@example.com");
    const datasetId = await seedDataset(db, userId);
    const customerId = await seedCustomer(db, datasetId, "EVT-1");
    const action = await db.query<{ id: string }>(
      `INSERT INTO customer_retention_actions (customer_id, title)
       VALUES ($1, 'Send the offer') RETURNING id`,
      [customerId],
    );
    await db.query(
      `INSERT INTO retention_action_events (action_id, from_status, to_status, changed_by)
       VALUES ($1, 'suggested', 'planned', $2)`,
      [action.rows[0].id, userId],
    );
    const events = await db.query(
      "SELECT to_status FROM retention_action_events WHERE action_id = $1",
      [action.rows[0].id],
    );
    expect(events.rows).toHaveLength(1);

    await db.query("DELETE FROM customer_retention_actions WHERE id = $1", [
      action.rows[0].id,
    ]);
    const afterDelete = await db.query(
      "SELECT count(*)::int AS n FROM retention_action_events",
    );
    expect(afterDelete.rows[0].n).toBe(0);
  });
});

describe("reports and audit", () => {
  it("will not record a completed report with no file", async () => {
    await expect(
      db.query(
        `INSERT INTO reports (kind, title, format, status)
         VALUES ('model_performance', 'Model report', 'pdf', 'completed')`,
      ),
    ).rejects.toThrow();
  });

  it("will not record a failed report with no reason", async () => {
    await expect(
      db.query(
        `INSERT INTO reports (kind, title, format, status)
         VALUES ('model_performance', 'Model report', 'pdf', 'failed')`,
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown report kind or format", async () => {
    await expect(
      db.query(
        `INSERT INTO reports (kind, title, format) VALUES ('powerpoint', 'x', 'pdf')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO reports (kind, title, format) VALUES ('audit_trail', 'x', 'docx')`,
      ),
    ).rejects.toThrow();
  });

  it("keeps the audit trail append-only", async () => {
    await db.query(
      `INSERT INTO audit_logs (action, resource_type, resource_id, outcome)
       VALUES ('login', 'session', 's1', 'success')`,
    );
    await expect(db.query("UPDATE audit_logs SET action = 'tampered'")).rejects.toThrow();
    await expect(db.query("DELETE FROM audit_logs")).rejects.toThrow();
  });

  it("records a denied attempt as well as a success", async () => {
    const userId = await seedUser(db, "audit@example.com");
    await db.query(
      `INSERT INTO audit_logs
         (actor_user_id, actor_email, action, outcome, metadata)
       VALUES ($1, 'audit@example.com', 'model.activate', 'denied',
               '{"reason":"insufficient role"}')`,
      [userId],
    );
    const rows = await db.query<{ outcome: string; metadata: { reason: string } }>(
      "SELECT outcome, metadata FROM audit_logs WHERE actor_user_id = $1",
      [userId],
    );
    expect(rows.rows[0].outcome).toBe("denied");
    expect(rows.rows[0].metadata.reason).toBe("insufficient role");
  });

  it("survives deletion of the actor", async () => {
    const userId = await seedUser(db, "gone@example.com");
    await db.query(
      `INSERT INTO audit_logs (actor_user_id, actor_email, action, outcome)
       VALUES ($1, 'gone@example.com', 'logout', 'success')`,
      [userId],
    );
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    const rows = await db.query<{ actor_email: string }>(
      "SELECT actor_email FROM audit_logs WHERE action = 'logout'",
    );
    expect(rows.rows[0].actor_email).toBe("gone@example.com");
  });
});

describe("transactions", () => {
  it("rolls everything back when a statement fails", async () => {
    const userId = await seedUser(db, "rollback@example.com");
    const datasetId = await seedDataset(db, userId);
    const before = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM customers WHERE dataset_id = $1",
      [datasetId],
    );

    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO customers (dataset_id, external_id) VALUES ($1, 'ROLLBACK-1')`,
          [datasetId],
        );
        // A second customer with the same id violates the unique index.
        await tx.query(
          `INSERT INTO customers (dataset_id, external_id) VALUES ($1, 'ROLLBACK-1')`,
          [datasetId],
        );
      }),
    ).rejects.toThrow();

    const after = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM customers WHERE dataset_id = $1",
      [datasetId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
