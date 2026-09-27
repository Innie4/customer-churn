/**
 * Retention actions, reports, the audit trail and settings.
 *
 * The point of the platform is that an explanation leads to an action, so the
 * retention tests assert the whole path: a suggestion exists, an operator
 * creates an action from it, the action is tracked to completion, and every
 * consequential step is attributable afterwards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as harness from "../support/harness";
import { startMlStub, type MlStub } from "../support/ml-stub";
import { POST as uploadDataset } from "@/app/api/datasets/route";
import { POST as preprocessDataset } from "@/app/api/datasets/[id]/preprocess/route";
import { POST as loadCustomers } from "@/app/api/datasets/[id]/customers/route";
import { POST as startTraining } from "@/app/api/training/route";
import { GET as getRun } from "@/app/api/training/[id]/route";
import { POST as activateModel } from "@/app/api/models/[id]/activate/route";
import { POST as generatePredictions } from "@/app/api/predictions/route";
import { GET as listStrategies, POST as createStrategy } from "@/app/api/retention/strategies/route";
import { GET as listActions, POST as createAction } from "@/app/api/retention/actions/route";
import {
  GET as getAction,
  PATCH as updateAction,
} from "@/app/api/retention/actions/[id]/route";
import { GET as listReports, POST as createReport } from "@/app/api/reports/route";
import { GET as getReport } from "@/app/api/reports/[id]/route";
import { GET as downloadReport } from "@/app/api/reports/[id]/download/route";
import { GET as listAudit } from "@/app/api/audit/route";
import { GET as getSettings, PATCH as updateSettings } from "@/app/api/settings/route";
import { GET as health } from "@/app/api/health/route";
import { POST as signOutUser } from "@/app/api/users/[id]/sign-out/route";

vi.mock("next/headers", () => ({
  cookies: async () => harness.activeJar,
  headers: async () => new Headers(),
}));

let app: Awaited<ReturnType<typeof harness.createAppContext>>;
let ml: MlStub;
let analyst: string;
let admin: string;
let viewer: string;
let modelId: string;
let customerId: string;
let strategyId: string;
let actionId: string;

beforeAll(async () => {
  app = await harness.createAppContext();
  ml = await startMlStub();
  analyst = await app.createUser({ email: "r-analyst@example.com", role: "analyst" });
  admin = await app.createUser({ email: "r-admin@example.com", role: "admin" });
  viewer = await app.createUser({ email: "r-viewer@example.com", role: "viewer" });

  const upload = await uploadDataset(
    await app.as(analyst, {
      method: "POST",
      url: "http://localhost/api/datasets",
      body: harness.csvUpload(harness.SAMPLE_CSV, "churn.csv", {
        target_column: "Churn",
        id_columns: "customerID",
      }),
    }),
    app.context({}),
  );
  const datasetId = (
    (await upload.clone().json()) as { data: { dataset?: { id?: string } } }
  ).data.dataset?.id ?? "";

  const prep = await preprocessDataset(
    await app.as(analyst, {
      method: "POST",
      url: `http://localhost/api/datasets/${datasetId}/preprocess`,
    }),
    app.context({ id: datasetId }),
  );
  const prepBody = (await prep.json()) as { data: { run: { id: string } } };

  await loadCustomers(
    await app.as(analyst, {
      method: "POST",
      url: `http://localhost/api/datasets/${datasetId}/customers`,
      body: "{}",
    }),
    app.context({ id: datasetId }),
  );

  const trained = await startTraining(
    await app.as(analyst, {
      method: "POST",
      url: "http://localhost/api/training",
      body: JSON.stringify({
        datasetId,
        preprocessingRunId: prepBody.data.run.id,
        modelTypes: ["logistic_regression"],
        label: "retention chain",
      }),
    }),
    app.context({}),
  );
  const runId = ((await trained.json()) as { data: { id?: string } }).data.id ?? "";
  await getRun(
    await app.as(analyst, {
      method: "GET",
      url: `http://localhost/api/training/${runId}`,
    }),
    app.context({ id: runId }),
  );

  const { listModels } = await import("@/lib/dal/models");
  const models = await listModels();
  modelId = models[0]?.id ?? "";

  await activateModel(
    await app.as(analyst, {
      method: "POST",
      url: `http://localhost/api/models/${modelId}/activate`,
      body: JSON.stringify({ reason: "Best test AUC of the candidates." }),
    }),
    app.context({ id: modelId }),
  );

  const predicted = await generatePredictions(
    await app.as(analyst, {
      method: "POST",
      url: "http://localhost/api/predictions",
      body: JSON.stringify({ modelId }),
    }),
    app.context({}),
  );
  const predictedBody = (await predicted.json()) as {
    data: { predictions: { id: string; customerId: string }[] };
  };
  customerId = predictedBody.data.predictions[0]?.customerId ?? "";

  const strategy = await createStrategy(
    await app.as(analyst, {
      method: "POST",
      url: "http://localhost/api/retention/strategies",
      body: JSON.stringify({
        title: "Offer a contract upgrade",
        description: "A month-to-month customer can leave with no friction.",
        triggeringCondition: "The model flagged a month-to-month contract.",
        riskDriver: "Contract: Month-to-month",
        suggestedIntervention: "Offer a bill credit in exchange for 12 months.",
        priority: "critical",
      }),
    }),
    app.context({}),
  );
  const strategyBody = (await strategy.clone().json()) as {
    data: { id?: string };
  };
  strategyId = strategyBody.data.id ?? "";

  // The action under test is created here rather than inside a test, so every
  // test in this file has it regardless of which one is running.
  const action = await createAction(
    await app.as(analyst, {
      method: "POST",
      url: "http://localhost/api/retention/actions",
      body: JSON.stringify({
        customerId,
        strategyId,
        title: "Call about a contract upgrade",
        description: "The model flagged the month-to-month contract.",
        priority: "high",
      }),
    }),
    app.context({}),
  );
  expect(action.status).toBe(201);
  const actionBody = (await action.json()) as { data: { id?: string } };
  actionId = actionBody.data.id ?? "";
});

afterAll(async () => {
  await ml.close();
  await app.close();
});

beforeEach(() => {
  harness.resetCookies();
});

describe("retention strategies", () => {
  it("creates a strategy as a proposal, not an approval", async () => {
    expect(strategyId).toBeTruthy();
    const row = await app.db.query<{ status: string; approved_by: string | null }>(
      "SELECT status, approved_by FROM retention_strategies WHERE id = $1",
      [strategyId],
    );
    // A schema constraint requires an approver and a timestamp, and no person
    // exists to attribute an automated approval to, so a new strategy is a
    // draft awaiting review.
    expect(row.rows[0].status).toBe("draft");
    expect(row.rows[0].approved_by).toBeNull();
  });

  it("lists strategies for any signed-in account", async () => {
    const response = await listStrategies(
      await app.as(viewer, {
        method: "GET",
        url: "http://localhost/api/retention/strategies",
      }),
      app.context({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { strategies: unknown[]; count: number };
    };
    expect(body.data.strategies.length).toBeGreaterThan(0);
    expect(body.data.count).toBe(body.data.strategies.length);
  });

  it("refuses a strategy with no title", async () => {
    const response = await createStrategy(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/retention/strategies",
        body: JSON.stringify({ title: "", description: "x" }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(422);
  });

  it("refuses a viewer creating one", async () => {
    const response = await createStrategy(
      await app.as(viewer, {
        method: "POST",
        url: "http://localhost/api/retention/strategies",
        body: JSON.stringify({
          title: "Viewer attempt",
          description: "x",
          triggeringCondition: "x",
          riskDriver: "x",
          suggestedIntervention: "x",
        }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(403);
  });
});

describe("retention actions", () => {
  it("created an action against a customer from the active model", async () => {
    expect(actionId).toBeTruthy();
    const row = await app.db.query<{ customer_id: string; status: string }>(
      "SELECT customer_id, status FROM customer_retention_actions WHERE id = $1",
      [actionId],
    );
    expect(row.rows[0].customer_id).toBe(customerId);
    expect(row.rows[0].status).toBe("suggested");
  });

  it("records the risk the customer carried when the action was created", async () => {
    const row = await app.db.query<{
      churn_probability_at_creation: string | null;
      status: string;
    }>(
      `SELECT churn_probability_at_creation, status
         FROM customer_retention_actions WHERE id = $1`,
      [actionId],
    );
    // The score at the moment of the decision, so the record does not change
    // when a newer prediction arrives.
    expect(Number(row.rows[0].churn_probability_at_creation)).toBeGreaterThan(0);
    expect(row.rows[0].status).toBe("suggested");
  });

  it("moves through its statuses and records each transition", async () => {
    for (const status of ["planned", "in_progress", "completed"] as const) {
      const response = await updateAction(
        await app.as(analyst, {
          method: "PATCH",
          url: `http://localhost/api/retention/actions/${actionId}`,
          body: JSON.stringify({ status }),
        }),
        app.context({ id: actionId }),
      );
      expect(response.status).toBe(200);
    }

    const row = await app.db.query<{ status: string; completed_at: string | null }>(
      "SELECT status, completed_at FROM customer_retention_actions WHERE id = $1",
      [actionId],
    );
    expect(row.rows[0].status).toBe("completed");
    // The schema requires a completion time, so it cannot be marked done
    // without one.
    expect(row.rows[0].completed_at).toBeTruthy();

    const history = await app.db.query<{ to_status: string }>(
      "SELECT to_status FROM retention_action_events WHERE action_id = $1 ORDER BY changed_at",
      [actionId],
    );
    const statuses = history.rows.map((h) => h.to_status);
    expect(statuses).toContain("planned");
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("completed");
  });

  it("refuses to cancel an action that was already completed", async () => {
    const created = await createAction(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/retention/actions",
        body: JSON.stringify({
          customerId,
          title: "Completed then cancelled",
          description: "x",
        }),
      }),
      app.context({}),
    );
    const body = (await created.json()) as { data: { id?: string } };
    const id = body.data.id ?? "";

    // An action moves through the intermediate states; jumping straight from
    // suggested to completed is refused, which is what the transition table is
    // for.
    const jump = await updateAction(
      await app.as(analyst, {
        method: "PATCH",
        url: `http://localhost/api/retention/actions/${id}`,
        body: JSON.stringify({ status: "completed" }),
      }),
      app.context({ id }),
    );
    expect(jump.status).toBe(422);

    for (const status of ["planned", "in_progress", "completed"] as const) {
      const step = await updateAction(
        await app.as(analyst, {
          method: "PATCH",
          url: `http://localhost/api/retention/actions/${id}`,
          body: JSON.stringify({ status }),
        }),
        app.context({ id }),
      );
      expect(step.status).toBe(200);
    }

    const cancelled = await updateAction(
      await app.as(analyst, {
        method: "PATCH",
        url: `http://localhost/api/retention/actions/${id}`,
        body: JSON.stringify({ status: "cancelled" }),
      }),
      app.context({ id }),
    );
    // An action that was completed cannot also be cancelled. The rule lives in
    // the database, so it holds however the write arrives.
    expect(cancelled.status).toBeGreaterThanOrEqual(400);

    const row = await app.db.query<{ status: string }>(
      "SELECT status FROM customer_retention_actions WHERE id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("completed");
  });

  it("refuses a viewer creating an action", async () => {
    const response = await createAction(
      await app.as(viewer, {
        method: "POST",
        url: "http://localhost/api/retention/actions",
        body: JSON.stringify({ customerId, title: "Viewer attempt" }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(403);
  });

  it("refuses an action for a customer that does not exist", async () => {
    const response = await createAction(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/retention/actions",
        body: JSON.stringify({
          customerId: "00000000-0000-4000-8000-000000000000",
          title: "Ghost customer",
        }),
      }),
      app.context({}),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("returns the action with the history of how it got there", async () => {
    const response = await getAction(
      await app.as(viewer, {
        method: "GET",
        url: `http://localhost/api/retention/actions/${actionId}`,
      }),
      app.context({ id: actionId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        action: { id: string; customerId: string; status: string };
        history: unknown[];
      };
    };
    expect(body.data.action.id).toBe(actionId);
    expect(body.data.action.customerId).toBe(customerId);
    // The history is what makes a retention decision auditable after the fact.
    expect(Array.isArray(body.data.history)).toBe(true);
  });

  it("404s an action that does not exist", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const response = await getAction(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/retention/actions/${missing}`,
      }),
      app.context({ id: missing }),
    );
    expect(response.status).toBe(404);
  });

  it("lists actions with their customer and strategy", async () => {
    const response = await listActions(
      await app.as(viewer, {
        method: "GET",
        url: "http://localhost/api/retention/actions",
      }),
      app.context({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { items: unknown[] } };
    expect(body.data.items.length).toBeGreaterThan(0);
  });
});

describe("reports", () => {
  it("generates a report and records it", async () => {
    const response = await createReport(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/reports",
        body: JSON.stringify({
          kind: "model_performance",
          format: "csv",
          modelResultId: modelId,
          title: "Performance report",
        }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id?: string } };
    const id = body.data.id ?? "";
    expect(id).toBeTruthy();

    const row = await app.db.query<{ status: string; storage_path: string | null }>(
      "SELECT status, storage_path FROM reports WHERE id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].storage_path).toBeTruthy();
  });

  it("streams the report bytes rather than wrapping them in JSON", async () => {
    const list = await listReports(
      await app.as(analyst, { method: "GET", url: "http://localhost/api/reports" }),
      app.context({}),
    );
    const listBody = (await list.json()) as { data: { reports: { id: string }[] } };
    const id = listBody.data.reports[0].id;

    const download = await downloadReport(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/reports/${id}/download`,
      }),
      app.context({ id }),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBeTruthy();
    // The bytes must not be a JSON envelope: this is the bug the raw-response
    // support in the route wrapper exists to prevent.
    expect(download.headers.get("content-type")).not.toContain("application/json");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("refuses a download to an anonymous caller", async () => {
    const list = await listReports(
      await app.as(analyst, { method: "GET", url: "http://localhost/api/reports" }),
      app.context({}),
    );
    const listBody = (await list.json()) as { data: { reports: { id: string }[] } };
    const id = listBody.data.reports[0].id;

    const download = await downloadReport(
      app.anonymous({
        method: "GET",
        url: `http://localhost/api/reports/${id}/download`,
      }),
      app.context({ id }),
    );
    // The report is behind a session check like everything else, so it cannot
    // be fetched from a guessable path.
    expect(download.status).toBe(401);
  });

  it("refuses an unknown format", async () => {
    const response = await createReport(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/reports",
        body: JSON.stringify({
          kind: "model_performance",
          format: "exe",
          title: "Bad format",
        }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(422);
  });

  it("404s a report that does not exist", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const response = await getReport(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/reports/${missing}`,
      }),
      app.context({ id: missing }),
    );
    expect(response.status).toBe(404);
  });
});

describe("the audit trail", () => {
  it("records the consequential steps of the chain", async () => {
    const response = await listAudit(
      await app.as(viewer, { method: "GET", url: "http://localhost/api/audit" }),
      app.context({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { items: { action: string; outcome: string }[] };
    };
    const actions = body.data.items.map((e) => e.action);
    expect(actions.some((a) => a.includes("dataset"))).toBe(true);
    expect(actions.some((a) => a.includes("prediction"))).toBe(true);
    expect(actions.some((a) => a.includes("retention") || a.includes("action"))).toBe(
      true,
    );
  });

  it("is readable by a viewer", async () => {
    const response = await listAudit(
      await app.as(viewer, { method: "GET", url: "http://localhost/api/audit" }),
      app.context({}),
    );
    expect(response.status).toBe(200);
  });

  it("never contains a password or a session token", async () => {
    const rows = await app.db.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_logs",
    );
    const serialised = JSON.stringify(rows.rows);
    expect(serialised).not.toMatch(/Correct-Horse-Battery-9/);
    expect(serialised.toLowerCase()).not.toContain("password_hash");
    expect(serialised.toLowerCase()).not.toContain("session_secret");
  });

  it("cannot be edited or deleted, even by direct SQL", async () => {
    // The database rejects it, so the guarantee does not depend on the
    // application behaving.
    const first = await app.db.query<{ id: string }>(
      "SELECT id FROM audit_logs ORDER BY created_at LIMIT 1",
    );
    expect(first.rows.length).toBeGreaterThan(0);
    const id = first.rows[0].id;
    const before = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs",
    );

    await expect(
      app.db.query("DELETE FROM audit_logs WHERE id = $1", [id]),
    ).rejects.toThrow();

    // A change to a recorded value is refused. Rewriting an entry's outcome to
    // what it already says is a no-op and is allowed, because nothing is being
    // altered — the trigger compares values rather than blocking every write.
    const current = await app.db.query<{ outcome: string }>(
      "SELECT outcome FROM audit_logs WHERE id = $1",
      [id],
    );
    const flipped = current.rows[0].outcome === "failure" ? "success" : "failure";
    await expect(
      app.db.query("UPDATE audit_logs SET outcome = $2 WHERE id = $1", [
        id,
        flipped,
      ]),
    ).rejects.toThrow();

    // The recorded outcome is unchanged.
    const stillThere = await app.db.query<{ outcome: string }>(
      "SELECT outcome FROM audit_logs WHERE id = $1",
      [id],
    );
    expect(stillThere.rows[0].outcome).toBe(current.rows[0].outcome);

    const total = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs",
    );
    expect(Number(total.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  it("permits detaching an actor from a deleted user, and nothing else", async () => {
    const analyst = await app.createUser({ email: "detach@example.com" });
    await app.db.query(
      `INSERT INTO audit_logs (actor_user_id, actor_email, action, resource_type, outcome, metadata)
       VALUES ($1, 'detach@example.com', 'test.action', 'test', 'success', '{}'::jsonb)`,
      [analyst],
    );
    const row = await app.db.query<{ id: string }>(
      "SELECT id FROM audit_logs WHERE actor_email = 'detach@example.com' LIMIT 1",
    );
    const id = row.rows[0].id;

    // The one permitted update: removing the reference when the user goes, so
    // the entry survives and stays attributable by email.
    await app.db.query(
      "UPDATE audit_logs SET actor_user_id = NULL WHERE id = $1",
      [id],
    );
    const detached = await app.db.query<{ actor_user_id: string | null; actor_email: string }>(
      "SELECT actor_user_id, actor_email FROM audit_logs WHERE id = $1",
      [id],
    );
    expect(detached.rows[0].actor_user_id).toBeNull();
    expect(detached.rows[0].actor_email).toBe("detach@example.com");
  });

  it("refuses an anonymous caller", async () => {
    const response = await listAudit(
      app.anonymous({ method: "GET", url: "http://localhost/api/audit" }),
      app.context({}),
    );
    expect(response.status).toBe(401);
  });
});

describe("settings", () => {
  it("is readable by a viewer and writable only by an administrator", async () => {
    const read = await getSettings(
      await app.as(viewer, { method: "GET", url: "http://localhost/api/settings" }),
      app.context({}),
    );
    expect(read.status).toBe(200);

    const denied = await updateSettings(
      await app.as(analyst, {
        method: "PATCH",
        url: "http://localhost/api/settings",
        body: JSON.stringify({ high: 0.8, medium: 0.5 }),
      }),
      app.context({}),
    );
    expect(denied.status).toBe(403);

    const allowed = await updateSettings(
      await app.as(admin, {
        method: "PATCH",
        url: "http://localhost/api/settings",
        body: JSON.stringify({ high: 0.8, medium: 0.5 }),
      }),
      app.context({}),
    );
    expect(allowed.status).toBe(200);
  });

  it("refuses thresholds that are not between zero and one", async () => {
    const response = await updateSettings(
      await app.as(admin, {
        method: "PATCH",
        url: "http://localhost/api/settings",
        body: JSON.stringify({ high: 4, medium: 0.5 }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(422);
  });

  it("refuses a setting key that is not a dotted lowercase name", async () => {
    const response = await updateSettings(
      await app.as(admin, {
        method: "PATCH",
        url: "http://localhost/api/settings",
        body: JSON.stringify({ "Bad Key!": "x" }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(422);
  });
});

describe("GET /api/health", () => {
  it("is public, so a load balancer can reach it without credentials", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    // Not wrapped in the API envelope: a probe should not have to know the
    // application's response shape.
    const body = (await response.json()) as {
      status: string;
      dependencies: {
        database: { status: string };
        mlService: { status: string; libraryVersions: unknown };
      };
      configurationProblems: string[];
    };
    expect(body.status).toBe("ok");
    expect(body.dependencies.database.status).toBe("ok");
    expect(body.dependencies.mlService.status).toBe("ok");
  });

  it("leaks no configuration value, only which variables are unmet", async () => {
    const text = await (await health()).text();
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/[A-Z]:\\\\/);
    expect(text).not.toContain("session_secret");
    expect(text).not.toContain("test-only-session-secret");

    const body = JSON.parse(text) as { configurationProblems: string[] };
    // Names only, never values: a probe response is often logged in full.
    for (const name of body.configurationProblems) {
      expect(name).toMatch(/^[A-Z_]+$/);
    }
  });

  it("reports the library versions the service is running", async () => {
    const body = (await (await health()).json()) as {
      dependencies: { mlService: { libraryVersions: Record<string, string> | null } };
    };
    // Reproducibility: the numbers a model reported depend on these.
    expect(body.dependencies.mlService.libraryVersions).toMatchObject({
      "scikit-learn": expect.any(String),
      shap: expect.any(String),
    });
  });
});

describe("administrator actions on other users", () => {
  it("refuses an analyst signing someone else out", async () => {
    const response = await signOutUser(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/users/${viewer}/sign-out`,
      }),
      app.context({ id: viewer }),
    );
    expect(response.status).toBe(403);
  });

  it("lets an administrator revoke a user's sessions", async () => {
    await app.signIn(viewer);
    const before = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [viewer],
    );
    expect(Number(before.rows[0].n)).toBeGreaterThan(0);

    const response = await signOutUser(
      await app.as(admin, {
        method: "POST",
        url: `http://localhost/api/users/${viewer}/sign-out`,
      }),
      app.context({ id: viewer }),
    );
    expect(response.status).toBe(200);

    const after = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [viewer],
    );
    expect(Number(after.rows[0].n)).toBe(0);
  });
});
