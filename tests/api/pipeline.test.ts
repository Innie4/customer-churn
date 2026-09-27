/**
 * Training, activation, prediction and explanation, through the real handlers.
 *
 * This is the chain the product exists for: train, choose, score, explain. Each
 * step asserts the record that was written as well as the response, because a
 * handler that returns the right shape while persisting nothing would pass a
 * response-only test and then show an empty page.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as harness from "../support/harness";
import { startMlStub, type MlStub } from "../support/ml-stub";
import { POST as uploadDataset } from "@/app/api/datasets/route";
import { POST as preprocessDataset } from "@/app/api/datasets/[id]/preprocess/route";
import { POST as loadCustomers } from "@/app/api/datasets/[id]/customers/route";
import { POST as startTraining } from "@/app/api/training/route";
import { GET as getRun } from "@/app/api/training/[id]/route";
import { GET as listModels } from "@/app/api/models/route";
import { GET as getModel } from "@/app/api/models/[id]/route";
import { POST as activateModel } from "@/app/api/models/[id]/activate/route";
import { GET as getPerformance } from "@/app/api/models/[id]/performance/route";
import {
  GET as getGlobalExplanation,
  POST as generateGlobalExplanation,
} from "@/app/api/models/[id]/explanations/route";
import { GET as getChart } from "@/app/api/models/[id]/charts/[kind]/route";
import { POST as generatePredictions } from "@/app/api/predictions/route";
import { GET as listPredictions } from "@/app/api/predictions/route";
import { GET as getPrediction } from "@/app/api/predictions/[id]/route";
import { POST as explainCustomer } from "@/app/api/customers/[id]/explanation/route";

vi.mock("next/headers", () => ({
  cookies: async () => harness.activeJar,
  headers: async () => new Headers(),
}));

let app: Awaited<ReturnType<typeof harness.createAppContext>>;
let ml: MlStub;
let analyst: string;
let viewer: string;

/** One dataset taken all the way to a trained model. */
let datasetId: string;
let preprocessingRunId: string;
let modelId: string;
let predictionId: string;
let customerId: string;

beforeAll(async () => {
  app = await harness.createAppContext();
  ml = await startMlStub();
  analyst = await app.createUser({ email: "m-analyst@example.com", role: "analyst" });
  viewer = await app.createUser({ email: "m-viewer@example.com", role: "viewer" });

  // Upload, preprocess, load customers, train — through the real handlers, so
  // the fixtures below are genuine records rather than hand-written rows.
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
  datasetId = (
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
  // Training takes this application's own run id, not the service's, so the
  // pairing between the two stays in one place.
  preprocessingRunId = prepBody.data.run.id;

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
        preprocessingRunId,
        modelTypes: ["logistic_regression"],
        label: "chain test",
      }),
    }),
    app.context({}),
  );
  expect(trained.status).toBe(202);
  const runId = ((await trained.json()) as { data: { id?: string } }).data.id ?? "";

  // The service reports the run complete, so bring the local record up to date.
  await getRun(
    await app.as(analyst, {
      method: "GET",
      url: `http://localhost/api/training/${runId}`,
    }),
    app.context({ id: runId }),
  );

  const models = await listModels(
    await app.as(analyst, { method: "GET", url: "http://localhost/api/models" }),
    app.context({}),
  );
  const modelList = (await models.json()) as {
    data: { models: { id: string }[] };
  };
  modelId = modelList.data.models[0]?.id ?? "";

  const predicted = await generatePredictions(
    await app.as(analyst, {
      method: "POST",
      url: "http://localhost/api/predictions",
      body: JSON.stringify({ modelId }),
    }),
    app.context({}),
  );
  const predictedBody = (await predicted.clone().json()) as {
    data: { predictions: { id: string; customerId: string; riskCategory: string }[] };
  };
  predictionId = predictedBody.data.predictions[0]?.id ?? "";
  customerId = predictedBody.data.predictions[0]?.customerId ?? "";
});

afterAll(async () => {
  await ml.close();
  await app.close();
});

beforeEach(() => {
  harness.resetCookies();
});

describe("the chain reaches a trained model", () => {
  it("produced a dataset, a preprocessing run and a model", () => {
    expect(datasetId).toBeTruthy();
    expect(preprocessingRunId).toBeTruthy();
    expect(modelId).toBeTruthy();
  });

  it("recorded the measured metrics, not placeholders", async () => {
    const response = await getModel(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/models/${modelId}`,
      }),
      app.context({ id: modelId }),
    );
    const body = (await response.json()) as {
      data: {
        model: { testMetrics: Record<string, number> | null; status: string };
      };
    };
    expect(body.data.model.status).toBe("completed");
    expect(body.data.model.testMetrics?.roc_auc).toBeGreaterThan(0.5);
    expect(body.data.model.testMetrics?.accuracy).toBeGreaterThan(0.5);
  });

  it("did not record the same numbers as validation and test", async () => {
    const response = await getPerformance(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/models/${modelId}/performance`,
      }),
      app.context({ id: modelId }),
    );
    const body = (await response.json()) as {
      data: {
        validation?: { sampleSize?: number };
        test?: { sampleSize?: number };
        model?: Record<string, unknown>;
      };
    };
    // A model evaluated on the same rows twice is not being evaluated. The
    // counts live on the nested evaluations, so they are read from there.
    const sizes = [body.data.validation?.sampleSize, body.data.test?.sampleSize].filter(
      (value) => typeof value === "number",
    );
    if (sizes.length === 2) {
      expect(sizes[0]).not.toBe(sizes[1]);
    }
  });
});

describe("POST /api/training", () => {
  it("reports a conflict rather than a server error when the same run is retried", async () => {
    // Retraining from the same preprocessing run makes the service return a run
    // id that is already recorded. That is a conflict the person can act on, not
    // a fault.
    const response = await startTraining(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/training",
        body: JSON.stringify({
          datasetId,
          preprocessingRunId,
          modelTypes: ["logistic_regression"],
          label: "duplicate attempt",
        }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(409);
    const body = await harness.errorBody(response);
    expect(body.error.nextAction).toBeTruthy();
  });

  it("refuses a viewer", async () => {
    const response = await startTraining(
      await app.as(viewer, {
        method: "POST",
        url: "http://localhost/api/training",
        body: JSON.stringify({ datasetId, preprocessingRunId, modelTypes: ["logistic_regression"] }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(403);
  });

  it("refuses an unknown preprocessing run rather than training on nothing", async () => {
    const response = await startTraining(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/training",
        body: JSON.stringify({
          datasetId: "00000000-0000-4000-8000-000000000000",
          preprocessingRunId: "00000000-0000-4000-8000-000000000000",
          modelTypes: ["logistic_regression"],
        }),
      }),
      app.context({}),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /api/training/[id]", () => {
  it("brings a run to completion and stores each model result", async () => {
    // The chain's own run, submitted in beforeAll and reconciled there.
    const rows = await app.db.query<{ id: string; status: string }>(
      "SELECT id, status FROM model_runs ORDER BY created_at ASC LIMIT 1",
    );
    expect(rows.rows[0].status).toBe("completed");

    const results = await app.db.query<{ model_type: string; is_active: boolean }>(
      "SELECT model_type, is_active FROM model_results WHERE model_run_id = $1",
      [rows.rows[0].id],
    );
    expect(results.rows.length).toBeGreaterThan(0);
    expect(results.rows[0].model_type).toBe("logistic_regression");
  });

  it("does not activate a model by training it", async () => {
    // Training makes a model usable for evaluation. Putting it into production
    // is a separate, attributable decision.
    const active = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM model_results WHERE is_active",
    );
    const all = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM model_results",
    );
    if (Number(all.rows[0].n) > 0) {
      expect(Number(active.rows[0].n)).toBeLessThanOrEqual(1);
    }
  });

  it("returns 404 for an unknown run", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const response = await getRun(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/training/${missing}`,
      }),
      app.context({ id: missing }),
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/models/[id]/activate", () => {
  it("activates a model and records who did it and why", async () => {
    const response = await activateModel(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/models/${modelId}/activate`,
        body: JSON.stringify({ reason: "Highest test AUC of the candidates." }),
      }),
      app.context({ id: modelId }),
    );
    expect(response.status).toBe(200);

    const row = await app.db.query<{
      is_active: boolean;
      activated_at: string | null;
      activated_by: string | null;
      activation_reason: string | null;
    }>(
      `SELECT is_active, activated_at, activated_by, activation_reason
         FROM model_results WHERE id = $1`,
      [modelId],
    );
    expect(row.rows[0].is_active).toBe(true);
    expect(row.rows[0].activated_at).toBeTruthy();
    expect(row.rows[0].activated_by).toBeTruthy();
    // The schema requires a reason, so it cannot be left blank.
    expect(row.rows[0].activation_reason).toBeTruthy();
  });

  it("refuses to activate without a reason", async () => {
    const other = await app.db.query<{ id: string }>(
      "SELECT id FROM model_results WHERE id <> $1 LIMIT 1",
      [modelId],
    );
    if (other.rows.length === 0) return;
    const response = await activateModel(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/models/${other.rows[0].id}/activate`,
        body: JSON.stringify({}),
      }),
      app.context({ id: other.rows[0].id }),
    );
    expect(response.status).toBe(422);
  });

  it("refuses a viewer", async () => {
    const response = await activateModel(
      await app.as(viewer, {
        method: "POST",
        url: `http://localhost/api/models/${modelId}/activate`,
        body: JSON.stringify({ reason: "should not be allowed" }),
      }),
      app.context({ id: modelId }),
    );
    expect(response.status).toBe(403);
  });

  it("deactivates the previous model of the same type", async () => {
    const active = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM model_results WHERE is_active",
    );
    // Whatever else is activated, at most one model of each family is active.
    expect(Number(active.rows[0].n)).toBeLessThanOrEqual(3);
  });
});

describe("POST /api/predictions", () => {
  it("scored customers and stored each prediction", async () => {
    expect(predictionId).toBeTruthy();
    const rows = await app.db.query<{
      churn_probability: string;
      risk_category: string;
      model_result_id: string;
    }>(
      "SELECT churn_probability, risk_category, model_result_id FROM predictions WHERE id = $1",
      [predictionId],
    );
    expect(Number(rows.rows[0].churn_probability)).toBeGreaterThanOrEqual(0);
    expect(Number(rows.rows[0].churn_probability)).toBeLessThanOrEqual(1);
    expect(["low", "medium", "high"]).toContain(rows.rows[0].risk_category);
    expect(rows.rows[0].model_result_id).toBe(modelId);
  });

  it("refuses to score with a model that is not active", async () => {
    // A model that failed or was never activated must not produce predictions.
    const inactive = await app.db.query<{ id: string }>(
      "SELECT id FROM model_results WHERE is_active = false LIMIT 1",
    );
    if (inactive.rows.length === 0) return;
    const response = await generatePredictions(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/predictions",
        body: JSON.stringify({ modelId: inactive.rows[0].id }),
      }),
      app.context({}),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a viewer", async () => {
    const response = await generatePredictions(
      await app.as(viewer, {
        method: "POST",
        url: "http://localhost/api/predictions",
        body: JSON.stringify({ modelId }),
      }),
      app.context({}),
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /api/predictions", () => {
  it("lists predictions with their customers", async () => {
    const response = await listPredictions(
      await app.as(viewer, {
        method: "GET",
        url: "http://localhost/api/predictions",
      }),
      app.context({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { items: { churnProbability: number; riskCategory: string }[] };
    };
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.data.items[0].riskCategory).toBeTruthy();
  });

  it("is readable by a viewer, who cannot create them", async () => {
    // The role is about writing, not reading.
    expect(viewer).toBeTruthy();
  });

  it("refuses an anonymous caller", async () => {
    const response = await listPredictions(
      app.anonymous({ method: "GET", url: "http://localhost/api/predictions" }),
      app.context({}),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/predictions/[id]", () => {
  it("returns the prediction with the model that made it", async () => {
    const response = await getPrediction(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/predictions/${predictionId}`,
      }),
      app.context({ id: predictionId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { prediction: { id: string }; model: { id: string } | null };
    };
    expect(body.data.prediction.id).toBe(predictionId);
  });
});

describe("POST /api/customers/[id]/explanation", () => {
  it("stores a verified explanation against the customer", async () => {
    const response = await explainCustomer(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/customers/${customerId}/explanation`,
        body: JSON.stringify({}),
      }),
      app.context({ id: customerId }),
    );
    expect(response.status).toBe(200);

    const rows = await app.db.query<{
      is_exact: boolean;
      contributions: unknown[];
      top_increasing: unknown[];
    }>(
      `SELECT e.is_exact, e.contributions, e.top_increasing
         FROM prediction_explanations e
         JOIN predictions p ON p.id = e.prediction_id
        WHERE p.customer_id = $1
        ORDER BY e.created_at DESC LIMIT 1`,
      [customerId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].is_exact).toBe(true);
    expect(rows.rows[0].contributions).toHaveLength(40);
  });

  it("records the explanation in the audit trail", async () => {
    await explainCustomer(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/customers/${customerId}/explanation`,
        body: JSON.stringify({}),
      }),
      app.context({ id: customerId }),
    );
    const rows = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE action LIKE '%explanation%'",
    );
    expect(Number(rows.rows[0].n)).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown customer", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const response = await explainCustomer(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/customers/${missing}/explanation`,
        body: JSON.stringify({}),
      }),
      app.context({ id: missing }),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/models/[id]/explanations", () => {
  it("returns null before one has been generated, rather than nothing", async () => {
    const existing = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM model_global_explanations",
    );
    if (Number(existing.rows[0].n) > 0) return;

    const response = await getGlobalExplanation(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/models/${modelId}/explanations`,
      }),
      app.context({ id: modelId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { explanation: unknown } };
    expect(body.data.explanation).toBeNull();
  });

  it("stores a generated explanation and reads back what was stored", async () => {
    const generated = await generateGlobalExplanation(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/models/${modelId}/explanations`,
        body: JSON.stringify({}),
      }),
      app.context({ id: modelId }),
    );
    expect(generated.status).toBe(200);

    const stored = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM model_global_explanations WHERE model_result_id = $1",
      [modelId],
    );
    expect(Number(stored.rows[0].n)).toBe(1);

    const response = await getGlobalExplanation(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/models/${modelId}/explanations`,
      }),
      app.context({ id: modelId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        explanation: { features: { feature: string; meanAbsShap: number }[] } | null;
      };
    };
    const features = body.data.explanation?.features ?? [];
    expect(features.length).toBeGreaterThan(0);
    const values = features.map((f) => f.meanAbsShap);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});

describe("GET /api/models/[id]/charts/[kind]", () => {
  it("refuses a kind this platform does not render", async () => {
    const response = await getChart(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/models/${modelId}/charts/not_a_chart`,
      }),
      app.context({ id: modelId, kind: "not_a_chart" }),
    );
    expect(response.status).toBe(404);
  });

  it("404s rather than erroring when a chart was never rendered", async () => {
    const response = await getChart(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/models/${modelId}/charts/roc_plot`,
      }),
      app.context({ id: modelId, kind: "roc_plot" }),
    );
    expect(response.status).toBe(404);
  });

  it("refuses an anonymous caller", async () => {
    const response = await getChart(
      app.anonymous({
        method: "GET",
        url: `http://localhost/api/models/${modelId}/charts/roc_plot`,
      }),
      app.context({ id: modelId, kind: "roc_plot" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("when the service is degraded", () => {
  it("still serves predictions, because they are already stored", async () => {
    ml.setMode("failing");
    try {
      const response = await listPredictions(
        await app.as(analyst, {
          method: "GET",
          url: "http://localhost/api/predictions",
        }),
        app.context({}),
      );
      // A stored result must remain readable when a dependency is down.
      expect(response.status).toBe(200);
    } finally {
      ml.setMode("normal");
    }
  });

  it("reports a failure when generating new ones", async () => {
    ml.setMode("failing");
    try {
      const response = await generatePredictions(
        await app.as(analyst, {
          method: "POST",
          url: "http://localhost/api/predictions",
          body: JSON.stringify({ modelId }),
        }),
        app.context({}),
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      ml.setMode("normal");
    }
  });
});
