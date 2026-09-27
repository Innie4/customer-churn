/**
 * A stand-in for the machine learning service.
 *
 * A real HTTP server rather than a mocked module, so the application's
 * multipart encoding, its URL building, its timeout handling and its error
 * mapping are all genuinely exercised. Only the modelling is replaced.
 *
 * Every response is shaped from the service's published schemas, and the
 * numbers are internally consistent: the probabilities match the recorded
 * metrics, and the SHAP contributions sum to the base value, because a stub that
 * returns incoherent figures would let a real defect hide behind it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface StubOptions {
  /** Answer /health as unhealthy, to exercise the dependency check. */
  healthy?: boolean;
  /** Make every route return 500, to exercise the failure path. */
  failEverything?: boolean;
  /** Delay before answering, in milliseconds. */
  delayMs?: number;
  /** Reject the API key. */
  requireKey?: boolean;
  apiKey?: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  contentType: string;
  bodyBytes: number;
  apiKey: string | null;
}

export interface MlStub {
  url: string;
  requests: RecordedRequest[];
  /** Requests to one path, for asserting a call was made. */
  callsTo: (path: string) => RecordedRequest[];
  /**
   * Change how the stub answers, at runtime.
   *
   * The application's configuration is read once at import, so the URL cannot
   * be pointed somewhere else mid-test. Changing behaviour on the same URL is
   * the only way to exercise a dependency outage.
   */
  setMode: (mode: "normal" | "failing" | "degraded" | "slow") => void;
  close: () => Promise<void>;
}

/**
 * The port the stub listens on.
 *
 * Fixed rather than ephemeral because the application's configuration is read
 * once at import, so the URL has to be known before any module under test is
 * evaluated. `tests/setup.ts` puts it in the environment; this is only the
 * definition.
 */
export const ML_STUB_PORT = 18_080;

/** 1x1 transparent PNG, enough to assert a real image came back. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CONTRIBUTION_COUNT = 40;

/** Build an explanation whose contributions genuinely sum to the prediction.
 *
 * The application recomputes the additivity check itself rather than trusting
 * what the service reports, so a stub whose figures did not add up would be
 * caught as inconsistent — which is the point. Here the contributions are built
 * backwards from the stated probability so the check genuinely passes.
 */
function localExplanation() {
  const probability = 0.7321;
  // Values chosen so the sum is exact in floating point: whole tenths of 1/1000.
  const values = Array.from({ length: CONTRIBUTION_COUNT }, (_, i) =>
    Math.round((Math.sin(i + 1) * 0.2 + 0.05) * 1000) / 1000,
  );
  const total = values.reduce((a, b) => a + b, 0);
  // Linear SHAP works in log-odds, so base + sum(shap) must rebuild the
  // log-odds of the probability, not the probability itself. Comparing in the
  // wrong space is how a correct explanation gets reported as a broken one, so
  // the figures are made consistent in the space they are actually in.
  const logOdds = Math.log(probability / (1 - probability));
  const base = Math.round((logOdds - total) * 1e6) / 1e6;

  return {
    model_id: "logistic_regression-test0001",
    model_version: 1,
    model_type: "logistic_regression",
    row_index: 0,
    customer_id: "C0001",
    churn_probability: probability,
    base_value: base,
    additive: true,
    reconstructed_probability:
      Math.round(1 / (1 + Math.exp(-(base + total))) * 1e6) / 1e6,
    additivity_tolerance: 0.02,
    summary:
      "This customer's estimated churn risk is 73%, pushed up by 12 factors " +
      "and reduced by 28. The contributions add up exactly to the prediction, " +
      "in log-odds.",
    top_increasing_risk: contributions(values, (v) => v > 0).slice(0, 5),
    top_reducing_risk: contributions(values, (v) => v < 0)
      .slice(-5)
      .reverse(),
    all_contributions: contributions(values, () => true),
    waterfall_plot_path: "C:/tmp/plots/waterfall-test.png",
    generated_at: "2026-01-01T00:00:00Z",
    disclaimer:
      "SHAP values describe how the model reached this prediction. They show " +
      "association and contribution, not causation.",
  };
}

function contributions(
  values: number[],
  keep: (value: number) => boolean,
) {
  return values
    .map((value, index) => ({
      feature: `feature_${index}`,
      label: `Feature ${index}`,
      shap_value: value,
      direction: value > 0 ? "increases_risk" : "reduces_risk",
      encoded_value: 0,
      description: `Feature ${index} contributed ${value.toFixed(3)}.`,
    }))
    .filter((c) => keep(c.shap_value));
}

const METRICS = {
  accuracy: 0.7374,
  precision: 0.5034,
  recall: 0.7968,
  f1: 0.617,
  roc_auc: 0.8386,
};

const CONFUSION = {
  true_negative: 880,
  false_positive: 155,
  false_negative: 81,
  true_positive: 293,
};

const ROC = {
  points: [
    { fpr: 0, tpr: 0 },
    { fpr: 1, tpr: 1 },
  ],
  auc: METRICS.roc_auc,
};

function evaluation(split: "validation_cv" | "test") {
  return {
    split,
    sample_size: split === "test" ? 1409 : 5634,
    positive_count: split === "test" ? 374 : 1495,
    metrics: METRICS,
    confusion_matrix: CONFUSION,
    roc: ROC,
    threshold: 0.5,
    evaluated_at: "2026-01-01T00:00:00Z",
    notes: [],
  };
}

function modelResult(modelType: string, mlModelId: string) {
  return {
    model_type: modelType,
    display_name:
      modelType === "logistic_regression"
        ? "Logistic Regression"
        : modelType === "random_forest"
          ? "Random Forest"
          : "XGBoost",
    status: "completed",
    grid_search: {
      scoring_metric: "roc_auc",
      cv_folds: 5,
      cv_strategy: "StratifiedKFold(n_splits=5, shuffle=True, random_state=42)",
      candidates_evaluated: 12,
      best_params: { C: 10, penalty: "l2", solver: "lbfgs" },
      best_cv_score: 0.8454,
      mean_fit_time_seconds: 0.4,
      per_fold_scores: [0.8418, 0.8387, 0.8558, 0.8422, 0.8488],
    },
    validation: evaluation("validation_cv"),
    test: evaluation("test"),
    decile_lift: {
      baseline_rate: 0.2654,
      rows: Array.from({ length: 10 }, (_, i) => ({
        decile: i + 1,
        row_count: 141,
        churners: Math.max(0, 140 - i * 12),
        actual_rate: Math.max(0, 140 - i * 12) / 141,
        predicted_rate: 0.1 + i * 0.08,
        lift: 1 + i * 2.6,
        cumulative_actual_rate: 0.05 + i * 0.09,
        cumulative_lift: 0.4 + i * 0.7,
      })),
    },
    artifact_path: mlModelId,
    error: null,
    error_stage: null,
  };
}

function trainingRun(status: "completed" | "failed" | "running") {
  const finished = status !== "running";
  return {
    run_id: "run0000000000000000000000000000",
    status,
    stage: finished ? "Training complete" : "Fitting models",
    progress_percent: finished ? 100 : 45,
    preprocessing_id: nextId("prep"),
    label: "stub run",
    requested_models: ["logistic_regression"],
    started_at: "2026-01-01T00:00:00Z",
    finished_at: finished ? "2026-01-01T00:00:30Z" : null,
    duration_seconds: finished ? 30 : null,
    models:
      status === "failed"
        ? [
            {
              ...modelResult("logistic_regression", "logistic_regression-fail"),
              status: "failed",
              error: "The estimator did not converge.",
              error_stage: "fitting",
              artifact_path: null,
            },
          ]
        : [modelResult("logistic_regression", "logistic_regression-test0001")],
    error: status === "failed" ? "The estimator did not converge." : null,
    error_stage: status === "failed" ? "fitting" : null,
    diagnostics: {},
  };
}

function globalExplanation() {
  const features = Array.from({ length: CONTRIBUTION_COUNT }, (_, i) => ({
    rank: i + 1,
    feature: i === 0 ? "tenure" : `feature_${i}`,
    label: i === 0 ? "Tenure (months)" : `Feature ${i}`,
    mean_abs_shap: Math.round((1.5 - i * 0.03) * 10000) / 10000,
    rank_importance: Math.round((1.0 - i * 0.02) * 10000) / 10000,
  }));
  return {
    model_id: "logistic_regression-test0001",
    model_version: 1,
    model_type: "logistic_regression",
    sample_size: 200,
    class_balance_note:
      "The churn class is 26.5% of the sample. Mean absolute SHAP values are " +
      "not comparable across datasets with different class balance.",
    features,
    beeswarm_plot_path: "C:/tmp/plots/beeswarm-test.png",
    importance_plot_path: "C:/tmp/plots/importance-test.png",
    generated_at: "2026-01-01T00:00:00Z",
    disclaimer:
      "SHAP values describe how the model reached its predictions. They show " +
      "association and contribution, not causation.",
  };
}

function predictions() {
  // 25% high, 30% medium, 45% low, which is plausible for this dataset.
  //
  // The first row's probability is the same one the explanation is built for.
  // The application recomputes the additivity check against the *stored*
  // prediction, so a stub whose explanation disagreed with its own score would
  // be reported as a non-exact explanation — correctly, but for the wrong
  // reason.
  return Array.from({ length: 4 }, (_, i) => ({
    row_index: i,
    customer_id: `C000${i + 1}`,
    churn_probability: [0.7321, 0.62, 0.44, 0.08][i],
    predicted_label: [1, 1, 0, 0][i],
    risk_category: ["high", "medium", "medium", "low"][i],
    risk_thresholds: { high: 0.7, medium: 0.4 },
    model_id: "logistic_regression-test0001",
    model_version: 1,
    model_type: "logistic_regression",
  }));
}

function inspectionReport() {
  return {
    filename: "churn.csv",
    size_bytes: 5,
    row_count: 4,
    column_count: 21,
    columns: [],
    duplicate_row_count: 0,
    target_column: "Churn",
    target_distribution: { no: 2, yes: 2 },
    target_positive_rate: 0.5,
    total_charges_blank_rows: 0,
    total_charges_blank_with_zero_tenure: 0,
    blank_string_cells: 0,
    issues: [
      {
        code: "duplicate_rows",
        severity: "warning",
        message: "The dataset contains duplicate rows.",
        detail: "1 row repeats an existing record.",
        column: null,
        affected_count: 1,
      },
    ],
    preview_rows: [],
    parser_used: "pandas.read_csv",
  };
}

/**
 * Counters for the identifiers the real service mints per request.
 *
 * The application stores these and several have unique constraints, so a stub
 * that returned the same value twice would fail on a constraint rather than on
 * the behaviour under test.
 */
let idCounter = 0;
const nextId = (prefix: string) => `${prefix}${(++idCounter).toString(16).padStart(28, "0")}`;

function preprocessResult() {
  return {
    preprocessing_id: nextId("prep"),
    created_at: "2026-01-01T00:00:00Z",
    params: {
      target_column: "Churn",
      id_columns: ["customerID"],
      test_size: 0.2,
      stratify: true,
      apply_smote: true,
      random_seed: 42,
      impute_total_charges_from_zero_tenure: true,
    },
    source_row_count: 4,
    source_column_count: 21,
    target_column: "Churn",
    target_positive_rate: 0.5,
    steps: [
      { step: "total_charges_numeric", description: "Coerce TotalCharges." },
      { step: "train_test_split", description: "Split 80:20, stratified." },
    ],
    split: {
      train_rows: 3,
      test_rows: 1,
      train_churners: 1,
      test_churners: 1,
      train_churn_rate: 0.3333,
      test_churn_rate: 1,
      stratified: true,
      random_seed: 42,
    },
    resample: {
      applied: true,
      method: "SMOTE",
      scope: "training_split_only",
      rows_before: 3,
      rows_after: 4,
      minority_before: 1,
      minority_after: 2,
      note: "Applied inside the training pipeline only.",
    },
    encoded_features: Array.from({ length: CONTRIBUTION_COUNT }, (_, i) => ({
      name: `feature_${i}`,
      label: `Feature ${i}`,
      kind: "numeric",
      source_column: "tenure",
      encoded_value: 0,
    })),
    encoded_feature_count: CONTRIBUTION_COUNT,
    warnings: [],
    scaler_mean: { tenure: 33.0 },
    scaler_scale: { tenure: 24.0 },
  };
}

/**
 * Start the stub.
 *
 * The response for each path is chosen here rather than in a fixture file, so
 * every shape a handler can receive is visible in one place.
 */
export async function startMlStub(
  initial: StubOptions = {},
): Promise<MlStub> {
  const requests: RecordedRequest[] = [];
  // Held by reference so `setMode` can change how later requests are answered.
  const options: StubOptions = { ...initial };

  const server: Server = createServer((req, res) => {
    // The handler is async; the errors it can raise are its own and are
    // reported by the assertions, not swallowed here.
    handle(req, res, options, requests).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ detail: { code: "stub_failure", message: "stub" } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ML_STUB_PORT, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${ML_STUB_PORT}`,
    requests,
    callsTo: (path) => requests.filter((r) => r.url.startsWith(path)),
    setMode: (mode) => {
      if (mode === "normal") {
        options.failEverything = false;
        options.healthy = true;
        options.delayMs = 0;
      } else if (mode === "failing") {
        options.failEverything = true;
      } else if (mode === "degraded") {
        options.failEverything = false;
        options.healthy = false;
      } else {
        options.failEverything = false;
        options.healthy = true;
        options.delayMs = 30_000;
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: StubOptions,
  requests: RecordedRequest[],
): Promise<void> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    bodyBytes += (chunk as Buffer).length;
  }

  const apiKey = (req.headers["x-ml-api-key"] as string | undefined) ?? null;
  requests.push({
    method: req.method ?? "GET",
    url: req.url ?? "/",
    contentType: String(req.headers["content-type"] ?? ""),
    bodyBytes,
    apiKey,
  });

  if (options.delayMs) {
    await new Promise((r) => setTimeout(r, options.delayMs));
  }

  const url = req.url ?? "/";
  const json = (status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  };
  const fail = (status: number, code: string, message: string): void =>
    json(status, { detail: { code, message } });
  const png = (): void => {
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": PNG.length,
    });
    res.end(PNG);
  };

  if (url.startsWith("/health")) {
    if (options.failEverything) return fail(500, "boom", "unavailable");
    return json(200, {
      status: options.healthy === false ? "degraded" : "ok",
      version: "1.0.0",
      artifact_dir: "C:/tmp",
      authentication_required: Boolean(options.apiKey),
      library_versions: {
        pandas: "3.0.6",
        numpy: "2.4.6",
        "scikit-learn": "1.4.2",
        "imbalanced-learn": "0.14.2",
        xgboost: "3.2.0",
        shap: "0.51.0",
        matplotlib: "3.8.4",
      },
    });
  }

  if (options.requireKey && options.apiKey && apiKey !== options.apiKey) {
    return fail(403, "forbidden", "The API key is missing or wrong.");
  }

  if (options.failEverything) {
    return fail(500, "internal_error", "The service hit an unexpected error.");
  }

  if (url.startsWith("/v1/datasets/inspect")) {
    return json(200, inspectionReport());
  }

  if (url.startsWith("/v1/datasets/preprocess")) {
    return json(200, preprocessResult());
  }

  if (url.startsWith("/v1/training/runs/") && url.includes("/roc-plot")) {
    if (url.includes("image=true")) return png();
    return json(200, { path: "C:/tmp/plots/roc-test.png" });
  }

  if (url.startsWith("/v1/training/runs")) {
    const isCollection = url === "/v1/training/runs" || url.startsWith("/v1/training/runs?");
    if (isCollection && req.method === "POST") {
      return json(202, trainingRun("running"));
    }
    if (isCollection) return json(200, [trainingRun("completed")]);
    // A specific run: the "failed" marker makes the failure path reachable.
    const body = url.includes("failed") ? trainingRun("failed") : trainingRun("completed");
    return json(200, body);
  }

  if (url.startsWith("/v1/models/") && url.includes("/explanation-capability")) {
    return json(200, {
      model_type: "logistic_regression",
      explainer: "Linear SHAP",
      exact: true,
      reason: "A generalised linear model has closed-form exact Shapley values.",
    });
  }

  if (url.startsWith("/v1/models/") && url.includes("/explanations/local")) {
    return json(200, localExplanation());
  }

  if (url.startsWith("/v1/models/") && url.includes("/explanations/global")) {
    return json(200, globalExplanation());
  }

  if (url.startsWith("/v1/models/") && url.includes("/predict")) {
    return json(200, {
      model_id: "logistic_regression-test0001",
      model_version: 1,
      model_type: "logistic_regression",
      predictions: predictions(),
      summary: {
        total: 4,
        low: 1,
        medium: 2,
        high: 1,
        high_share: 0.25,
        mean_probability: 0.5125,
        thresholds: { high: 0.7, medium: 0.4 },
      },
      warnings: [],
      generated_at: "2026-01-01T00:00:00Z",
    });
  }

  if (url.startsWith("/v1/plots/")) {
    if (!url.endsWith(".png")) return fail(404, "not_found", "No such chart.");
    return png();
  }

  return fail(404, "not_found", `No stub for ${url}`);
}
