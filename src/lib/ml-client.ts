/**
 * Client for the Python machine learning service.
 *
 * The application owns authentication, authorisation, persistence and the user
 * interface. The ML service owns the pipeline. This module is the only place
 * the two meet, and it never exposes the service's API key to a client.
 *
 * Failure handling is deliberate. A dependency that is down must produce a
 * diagnosable error naming the failed stage, not a stack trace and not a
 * fabricated result.
 */

import "server-only";

import { AppError } from "./api";
import { env } from "./env";

export interface MlServiceFailure {
  stage: string;
  status: number;
  code: string;
  message: string;
  diagnostics?: Record<string, unknown>;
}

export class MlServiceError extends AppError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly stage: string,
    options: { nextAction?: string; diagnostics?: Record<string, unknown> } = {},
  ) {
    super(status, code, message, options);
    this.name = "MlServiceError";
  }
}

interface RequestOptions {
  /** Which pipeline stage this call belongs to, used in error messages. */
  stage: string;
  method?: "GET" | "POST";
  path: string;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  /** Longer budget for training, which is genuinely slow. */
  timeoutMs?: number;
}

async function request<T>(options: RequestOptions): Promise<T> {
  const {
    stage,
    path,
    body,
    form,
    method = body || form ? "POST" : "GET",
    timeoutMs = env.mlRequestTimeoutMs,
  } = options;

  const url = `${env.mlServiceUrl.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.mlServiceApiKey) headers["x-ml-api-key"] = env.mlServiceApiKey;
  if (body) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: form ?? (body ? JSON.stringify(body) : undefined),
      signal: options.signal ?? controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new MlServiceError(
      aborted ? 504 : 503,
      aborted ? "ml_service_timeout" : "ml_service_unreachable",
      aborted
        ? "The machine learning service did not respond in time."
        : "The machine learning service could not be reached.",
      stage,
      {
        nextAction: aborted
          ? "The operation may still be running. Check its status before retrying."
          : "Start the machine learning service, then try again.",
      },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: text.slice(0, 1000) };
    }
  }

  if (!response.ok) {
    throw toMlError(payload, response.status, stage);
  }

  return payload as T;
}

/**
 * Fetch binary content, such as a rendered chart.
 *
 * Separate from `request` because that one parses JSON, and a PNG handed to
 * `JSON.parse` becomes a confusing parse error rather than a useful one.
 */
async function requestBinary(options: RequestOptions): Promise<Buffer> {
  const { stage, path, timeoutMs = env.mlRequestTimeoutMs } = options;
  const url = `${env.mlServiceUrl.replace(/\/+$/, "")}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Accept: "image/*" };
  if (env.mlServiceApiKey) headers["x-ml-api-key"] = env.mlServiceApiKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      signal: options.signal ?? controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new MlServiceError(
      aborted ? 504 : 503,
      aborted ? "ml_service_timeout" : "ml_service_unreachable",
      aborted
        ? "The machine learning service did not respond in time."
        : "The machine learning service could not be reached.",
      stage,
      {
        nextAction: aborted
          ? "The chart may still be rendering. Check its status before retrying."
          : "Start the machine learning service, then try again.",
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw toMlError(safeParse(text), response.status, stage);
  }

  return Buffer.from(await response.arrayBuffer());
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 1000) };
  }
}

/**
 * Reduce a plot path from the service to a name it will serve.
 *
 * The service returns an absolute path on its own filesystem. That path is
 * meaningless to this process, so only the file name is used, and it is
 * validated here as well as on the service so a malformed value is rejected
 * before a request is made.
 */
export function plotName(plotPath: string | null | undefined): string | null {
  if (!plotPath) return null;
  const name = plotPath.replace(/\\/g, "/").split("/").pop() ?? "";
  // A name is a file name and nothing else.
  if (!/^[A-Za-z0-9._-]+\.png$/i.test(name) || name.startsWith(".")) return null;
  return name;
}

/** Map the service's error shape onto an application error. */
function toMlError(
  payload: unknown,
  status: number,
  stage: string,
): MlServiceError {
  const detail = (payload as { detail?: unknown } | null)?.detail;

  if (detail && typeof detail === "object") {
    const record = detail as {
      code?: string;
      message?: string;
      stage?: string;
      issues?: unknown;
    };
    return new MlServiceError(
      status === 422 ? 422 : status >= 500 ? 502 : status,
      record.code ?? "ml_request_failed",
      record.message ?? "The machine learning service rejected the request.",
      record.stage ?? stage,
      {
        nextAction:
          status === 422
            ? "Fix the reported data problems, then run the step again."
            : "Try again, and check the machine learning service log if it persists.",
        diagnostics: record.issues ? { issues: record.issues } : undefined,
      },
    );
  }

  if (typeof detail === "string") {
    return new MlServiceError(
      status === 422 ? 422 : status >= 500 ? 502 : status,
      "ml_request_failed",
      detail,
      stage,
    );
  }

  return new MlServiceError(
    status >= 500 ? 502 : status,
    "ml_request_failed",
    `The machine learning service returned ${status}.`,
    stage,
  );
}

// ---------------------------------------------------------------------------
// Typed calls. Each returns the service's own response, so the shapes stay in
// one place rather than being re-declared at every call site.
// ---------------------------------------------------------------------------

export interface MlColumn {
  name: string;
  position: number;
  inferred_type: string;
  pandas_dtype: string;
  non_null_count: number;
  null_count: number;
  null_fraction: number;
  distinct_count: number;
  sample_values: unknown[];
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  is_target: boolean;
}

export interface MlIssue {
  code: string;
  severity: "error" | "warning" | "info";
  column: string | null;
  message: string;
  detail: string | null;
  affected_count: number | null;
}

export interface MlInspection {
  filename: string;
  size_bytes: number;
  row_count: number;
  column_count: number;
  columns: MlColumn[];
  duplicate_row_count: number;
  target_column: string;
  target_distribution: Record<string, number>;
  target_positive_rate: number;
  total_charges_blank_rows: number;
  total_charges_blank_with_zero_tenure: number;
  blank_string_cells: number;
  issues: MlIssue[];
  preview_rows: Record<string, unknown>[];
}

export interface MlPreprocessStep {
  step: string;
  description: string;
  affected_columns: string[];
  rows_in: number;
  rows_out: number;
  details: Record<string, unknown>;
  warnings: string[];
}

export interface MlPreprocessResult {
  preprocessing_id: string;
  created_at: string;
  params: Record<string, unknown>;
  source_row_count: number;
  source_column_count: number;
  target_column: string;
  target_positive_rate: number;
  steps: MlPreprocessStep[];
  split: {
    train_rows: number;
    test_rows: number;
    train_churners: number;
    test_churners: number;
    train_churn_rate: number;
    test_churn_rate: number;
    stratified: boolean;
    random_seed: number;
  };
  resample: {
    applied: boolean;
    method: string | null;
    scope: string;
    rows_before: number | null;
    rows_after: number | null;
    note: string;
  };
  encoded_features: {
    name: string;
    source_column: string;
    kind: string;
    level: string | null;
    scaled: boolean;
    label: string;
  }[];
  encoded_feature_count: number;
  warnings: string[];
  scaler_mean: Record<string, number>;
  scaler_scale: Record<string, number>;
}

export interface MlMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  roc_auc: number;
}

export interface MlConfusion {
  true_negative: number;
  false_positive: number;
  false_negative: number;
  true_positive: number;
}

export interface MlModelResult {
  model_type: "logistic_regression" | "random_forest" | "xgboost";
  display_name: string;
  status: "completed" | "failed";
  grid_search: {
    scoring_metric: string;
    cv_folds: number;
    cv_strategy: string;
    candidates_evaluated: number;
    best_params: Record<string, unknown>;
    best_cv_score: number;
    mean_fit_time_seconds: number;
    per_fold_scores: number[];
  };
  validation: MlEvaluation;
  test: MlEvaluation | null;
  decile_lift: {
    deciles: number;
    baseline_churn_rate: number;
    rows: {
      decile: number;
      customers: number;
      churners: number;
      churn_rate: number;
      lift: number;
      cumulative_captured: number;
    }[];
  } | null;
  artifact_path: string | null;
  error: string | null;
  error_stage: string | null;
}

export interface MlEvaluation {
  split: "validation_cv" | "test";
  sample_size: number;
  positive_count: number;
  metrics: MlMetrics | null;
  confusion_matrix: MlConfusion | null;
  roc: { points: { fpr: number; tpr: number; threshold: number }[]; auc: number } | null;
  threshold: number;
  evaluated_at: string;
  notes: string[];
}

export interface MlTrainingRun {
  run_id: string;
  status: "queued" | "running" | "evaluating" | "completed" | "failed" | "cancelled";
  stage: string;
  progress_percent: number;
  preprocessing_id: string;
  label: string | null;
  requested_models: string[];
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  models: MlModelResult[];
  error: string | null;
  error_stage: string | null;
  diagnostics: Record<string, unknown>;
}

export interface MlPrediction {
  row_index: number;
  customer_id: string | null;
  churn_probability: number;
  predicted_label: number;
  risk_category: "low" | "medium" | "high";
  risk_thresholds: { high: number; medium: number };
  model_id: string;
  model_version: string;
  model_type: string;
}

export interface MlPredictResponse {
  model_id: string;
  model_version: string;
  model_type: string;
  row_count: number;
  positive_rate: number;
  risk_counts: Record<string, number>;
  thresholds: { high: number; medium: number };
  predictions: MlPrediction[];
  warnings: string[];
}

export interface MlContribution {
  feature: string;
  label: string;
  source_column: string;
  value: string;
  shap_value: number;
  direction: "increases_risk" | "reduces_risk";
  kind: string;
}

export interface MlLocalExplanation {
  model_id: string;
  model_version: string;
  model_type: string;
  row_index: number;
  customer_id: string | null;
  churn_probability: number;
  base_value: number;
  summary: string;
  top_increasing_risk: MlContribution[];
  top_reducing_risk: MlContribution[];
  all_contributions: MlContribution[];
  waterfall_plot_path: string | null;
  generated_at: string;
  disclaimer: string;
}

export interface MlGlobalFeature {
  rank: number;
  feature: string;
  label: string;
  source_column: string;
  mean_abs_shap: number;
  direction: "increases_risk" | "reduces_risk" | "mixed";
  kind: string;
}

export interface MlGlobalExplanation {
  model_id: string;
  model_version: string;
  model_type: string;
  sample_size: number;
  class_balance_note: string;
  features: MlGlobalFeature[];
  beeswarm_plot_path: string | null;
  importance_plot_path: string | null;
  generated_at: string;
  disclaimer: string;
}

export interface MlServiceHealth {
  status: string;
  version: string;
  artifact_dir: string;
  authentication_required: boolean;
  library_versions: Record<string, string>;
}

function csvForm(
  file: { buffer: Buffer; filename: string; contentType: string },
  fields: Record<string, string | number | boolean | undefined>,
): FormData {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(file.buffer)], {
    type: file.contentType,
  });
  form.append("file", blob, file.filename);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value));
  }
  return form;
}

export const ml = {
  health(): Promise<MlServiceHealth> {
    return request<MlServiceHealth>({ stage: "health", path: "/health" });
  },

  inspect(
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { targetColumn?: string; idColumns?: string[]; previewRows?: number } = {},
  ): Promise<MlInspection> {
    return request<MlInspection>({
      stage: "dataset_inspection",
      path: "/v1/datasets/inspect",
      form: csvForm(file, {
        target_column: options.targetColumn,
        id_columns: options.idColumns?.join(","),
        preview_rows: options.previewRows ?? 10,
      }),
    });
  },

  preprocess(
    file: { buffer: Buffer; filename: string; contentType: string },
    options: {
      targetColumn: string;
      idColumns?: string[];
      testSize?: number;
      stratify?: boolean;
      applySmote?: boolean;
      randomSeed?: number;
    },
  ): Promise<MlPreprocessResult> {
    return request<MlPreprocessResult>({
      stage: "dataset_preprocessing",
      path: "/v1/datasets/preprocess",
      form: csvForm(file, {
        target_column: options.targetColumn,
        id_columns: options.idColumns?.join(","),
        test_size: options.testSize ?? 0.2,
        stratify: options.stratify ?? true,
        apply_smote: options.applySmote ?? true,
        random_seed: options.randomSeed ?? 42,
      }),
    });
  },

  startTraining(body: {
    preprocessing_id: string;
    model_types?: string[];
    cv_folds?: number;
    random_seed?: number;
    run_label?: string;
  }): Promise<MlTrainingRun> {
    return request<MlTrainingRun>({
      stage: "model_training",
      path: "/v1/training/runs",
      body,
    });
  },

  trainingRun(runId: string): Promise<MlTrainingRun> {
    return request<MlTrainingRun>({
      stage: "model_training",
      path: `/v1/training/runs/${encodeURIComponent(runId)}`,
    });
  },

  listTrainingRuns(limit = 25): Promise<MlTrainingRun[]> {
    return request<MlTrainingRun[]>({
      stage: "model_training",
      path: `/v1/training/runs?limit=${limit}`,
    });
  },

  predict(
    modelId: string,
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { high?: number; medium?: number; idColumns?: string[] } = {},
  ): Promise<MlPredictResponse> {
    return request<MlPredictResponse>({
      stage: "prediction",
      path: `/v1/models/${encodeURIComponent(modelId)}/predict`,
      form: csvForm(file, {
        high_threshold: options.high ?? 0.7,
        medium_threshold: options.medium ?? 0.4,
        id_columns: options.idColumns?.join(","),
      }),
    });
  },

  localExplanation(
    modelId: string,
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { rowIndex?: number; customerId?: string; topN?: number } = {},
  ): Promise<MlLocalExplanation> {
    return request<MlLocalExplanation>({
      stage: "explanation",
      path: `/v1/models/${encodeURIComponent(modelId)}/explanations/local`,
      form: csvForm(file, {
        row_index: options.rowIndex ?? 0,
        customer_id: options.customerId,
        top_n: options.topN ?? 5,
      }),
    });
  },

  globalExplanation(
    modelId: string,
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { sampleSize?: number; renderPlots?: boolean } = {},
  ): Promise<MlGlobalExplanation> {
    return request<MlGlobalExplanation>({
      stage: "explanation",
      path: `/v1/models/${encodeURIComponent(modelId)}/explanations/global`,
      form: csvForm(file, {
        sample_size: options.sampleSize ?? env.mlShapSampleSize,
        render_plots: options.renderPlots ?? true,
      }),
    });
  },

  rocPlot(runId: string): Promise<{ path: string | null }> {
    return request<{ path: string | null }>({
      stage: "model_evaluation",
      path: `/v1/training/runs/${encodeURIComponent(runId)}/roc-plot`,
    });
  },

  /**
   * Fetch a rendered chart as image bytes.
   *
   * Takes the path the service reported and asks for that chart by name. The
   * alternative — reading the file from disk — only works when both processes
   * share a filesystem, which local development does and a deployment does not.
   */
  async plot(plotPath: string | null | undefined): Promise<Buffer | null> {
    const name = plotName(plotPath);
    if (!name) return null;
    return requestBinary({
      stage: "model_evaluation",
      path: `/v1/plots/${encodeURIComponent(name)}`,
    });
  },
};

/** True when the service answers its health check. Used by the status page. */
export async function mlServiceReachable(): Promise<MlServiceHealth | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${env.mlServiceUrl.replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as MlServiceHealth;
  } catch {
    return null;
  }
}
