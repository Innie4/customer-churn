/**
 * Training runs, model results, activation and model-risk review.
 *
 * Model activation is a human decision, recorded with who made it, when and
 * why. There is no automatic "best model" promotion: the interface presents the
 * measured metrics and the trade-offs, and a person chooses.
 */

import "server-only";

import { getDatabase, DatabaseError } from "../../../db/client";
import { AppError } from "../api";
import { AUDIT, recordAudit } from "../audit";
import { ml, plotName, type MlModelResult, type MlTrainingRun } from "../ml-client";
import {
  requireActor,
  requireCapability,
  type Actor,
} from "./access";
import { isUuid, readDatasetFile } from "./datasets";

export type ModelType = "logistic_regression" | "random_forest" | "xgboost";
export type ModelStatus = "pending" | "completed" | "failed";
export type RunStatus =
  | "queued"
  | "running"
  | "evaluating"
  | "completed"
  | "failed"
  | "cancelled";

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  logistic_regression: "Logistic Regression",
  random_forest: "Random Forest",
  xgboost: "XGBoost",
};

/**
 * What each model is in the comparison, stated plainly.
 *
 * The study's point is that accuracy and interpretability are not competing
 * goals, so each entry says what the model buys and what it costs.
 */
export const MODEL_TYPE_NOTES: Record<ModelType, string> = {
  logistic_regression:
    "The most transparent of the three. Every feature carries a directly readable weight, so a prediction can be argued about without extra tooling. Captures straight-line relationships only.",
  random_forest:
    "Hundreds of averaged trees, so it handles non-linear relationships and feature interactions. Harder to read directly, which is exactly what the explanation layer is for.",
  xgboost:
    "Trees built in sequence, each correcting the last. Usually the strongest on tabular data, and the hardest to read, so it leans on the explanation layer most.",
};

export interface ModelRunSummary {
  id: string;
  mlRunId: string | null;
  datasetId: string;
  datasetName: string | null;
  label: string | null;
  status: RunStatus;
  stage: string;
  progressPercent: number;
  requestedModels: string[];
  cvFolds: number;
  randomSeed: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  error: string | null;
  errorStage: string | null;
  createdAt: string;
  startedByName: string | null;
  modelCount: number;
  completedCount: number;
  failedCount: number;
}

export interface ModelResultSummary {
  id: string;
  modelRunId: string;
  modelType: ModelType;
  displayName: string;
  status: ModelStatus;
  version: string | null;
  mlModelId: string | null;
  isActive: boolean;
  activatedAt: string | null;
  activatedByName: string | null;
  activationReason: string | null;
  hyperparameters: Record<string, unknown>;
  cvScore: number | null;
  testMetrics: Record<string, number> | null;
  testConfusion: Record<string, number> | null;
  decileLift: Record<string, unknown> | null;
  error: string | null;
  errorStage: string | null;
  createdAt: string;
}

export interface ModelDetail extends ModelResultSummary {
  gridSearch: Record<string, unknown>;
  validationMetrics: Record<string, number> | null;
  validationConfusion: Record<string, number> | null;
  testRoc: Record<string, unknown> | null;
  testNotes: string[];
  validationNotes: string[];
  trainDurationSeconds: number | null;
  featureCount: number | null;
  datasetId: string;
  datasetName: string | null;
  preprocessingRunId: string;
  preprocessingVersion: string | null;
  artifacts: ArtifactSummary[];
  riskReviews: RiskReviewSummary[];
}

export interface ArtifactSummary {
  id: string;
  kind: string;
  storagePath: string;
  sizeBytes: number | null;
  contentType: string;
}

/**
 * The charts the platform knows how to render.
 *
 * Matches the `kind` check constraint on `model_artifacts`, so an unknown kind
 * cannot be recorded or requested.
 */
export const ModelChartKind = {
  Confusion: "confusion_plot",
  Roc: "roc_plot",
  Decile: "decile_plot",
  Beeswarm: "beeswarm_plot",
  Importance: "importance_plot",
  Waterfall: "waterfall_plot",
} as const;

export type ModelChartKind = (typeof ModelChartKind)[keyof typeof ModelChartKind];

const CHART_FILENAMES: Record<ModelChartKind, string> = {
  [ModelChartKind.Confusion]: "confusion-matrix.png",
  [ModelChartKind.Roc]: "roc-curve.png",
  [ModelChartKind.Decile]: "decile-lift.png",
  [ModelChartKind.Beeswarm]: "shap-beeswarm.png",
  [ModelChartKind.Importance]: "shap-importance.png",
  [ModelChartKind.Waterfall]: "shap-waterfall.png",
};

export interface RiskReviewSummary {
  id: string;
  feature: string;
  concernType: string;
  severity: string;
  meanAbsShap: number | null;
  status: string;
  notes: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

interface RunRow {
  id: string;
  ml_run_id: string | null;
  dataset_id: string;
  preprocessing_run_id: string;
  dataset_name: string | null;
  label: string | null;
  status: RunStatus;
  stage: string;
  progress_percent: number;
  requested_models: string[];
  cv_folds: number;
  random_seed: number;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: string | null;
  error: string | null;
  error_stage: string | null;
  created_at: string;
  started_by_name: string | null;
  model_count: string;
  completed_count: string;
  failed_count: string;
}

const RUN_SELECT = `
  SELECT r.*, d.name AS dataset_name, u.full_name AS started_by_name,
         (SELECT count(*) FROM model_results m WHERE m.model_run_id = r.id) AS model_count,
         (SELECT count(*) FROM model_results m WHERE m.model_run_id = r.id
           AND m.status = 'completed') AS completed_count,
         (SELECT count(*) FROM model_results m WHERE m.model_run_id = r.id
           AND m.status = 'failed') AS failed_count
    FROM model_runs r
    LEFT JOIN datasets d ON d.id = r.dataset_id
    LEFT JOIN users u ON u.id = r.started_by
`;

function toRunSummary(row: RunRow): ModelRunSummary {
  return {
    id: row.id,
    mlRunId: row.ml_run_id,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    label: row.label,
    status: row.status,
    stage: row.stage,
    progressPercent: row.progress_percent,
    requestedModels: row.requested_models ?? [],
    cvFolds: row.cv_folds,
    randomSeed: row.random_seed,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationSeconds: row.duration_seconds ? Number(row.duration_seconds) : null,
    error: row.error,
    errorStage: row.error_stage,
    createdAt: row.created_at,
    startedByName: row.started_by_name,
    modelCount: Number(row.model_count),
    completedCount: Number(row.completed_count),
    failedCount: Number(row.failed_count),
  };
}

export interface StartTrainingInput {
  datasetId: string;
  preprocessingRunId: string;
  modelTypes: ModelType[];
  cvFolds: number;
  randomSeed: number;
  label?: string;
}

export async function startTraining(
  input: StartTrainingInput,
): Promise<ModelRunSummary> {
  const actor = await requireCapability("manageModels");
  const db = await getDatabase();

  if (!isUuid(input.datasetId) || !isUuid(input.preprocessingRunId)) {
    throw AppError.badRequest("The dataset or preprocessing run id is not valid.");
  }
  if (input.modelTypes.length === 0) {
    throw AppError.unprocessable("Choose at least one model to train.", {
      fields: { modelTypes: "Choose at least one model." },
    });
  }

  const preprocessing = await db.query<{
    id: string;
    ml_preprocessing_id: string;
    dataset_id: string;
    status: string;
  }>(
    `SELECT id, ml_preprocessing_id, dataset_id, status
       FROM preprocessing_runs WHERE id = $1`,
    [input.preprocessingRunId],
  );
  const record = preprocessing.rows[0];
  if (!record) {
    throw AppError.notFound("That preprocessing run does not exist.");
  }
  if (record.status !== "completed") {
    throw AppError.unprocessable(
      "That preprocessing run did not complete, so it cannot be trained on.",
      { nextAction: "Run preprocessing again before training." },
    );
  }
  if (record.dataset_id !== input.datasetId) {
    throw AppError.badRequest(
      "That preprocessing run belongs to a different dataset.",
    );
  }

  const created = await db.query<{ id: string }>(
    `INSERT INTO model_runs
       (dataset_id, preprocessing_run_id, label, status, stage, requested_models,
        cv_folds, random_seed, started_by, started_at)
     VALUES ($1, $2, $3, 'queued', 'Waiting for a training worker', $4::jsonb,
             $5, $6, $7, now())
     RETURNING id`,
    [
      input.datasetId,
      input.preprocessingRunId,
      input.label ?? null,
      JSON.stringify(input.modelTypes),
      input.cvFolds,
      input.randomSeed,
      actor.id,
    ],
  );
  const runId = created.rows[0].id;

  await recordAudit({
    action: AUDIT.trainingStarted,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "model_run",
    resourceId: runId,
    metadata: {
      modelTypes: input.modelTypes,
      cvFolds: input.cvFolds,
      preprocessingRunId: input.preprocessingRunId,
    },
  });

  let serviceRun: MlTrainingRun;
  try {
    serviceRun = await ml.startTraining({
      preprocessing_id: record.ml_preprocessing_id,
      model_types: input.modelTypes,
      cv_folds: input.cvFolds,
      random_seed: input.randomSeed,
      run_label: input.label,
    });
  } catch (error) {
    // The run row stays, marked failed, so the history shows the attempt.
    await db.query(
      `UPDATE model_runs
          SET status = 'failed', stage = 'The training service could not be reached',
              error = $2, error_stage = 'submit', finished_at = now(), progress_percent = 100
        WHERE id = $1`,
      [runId, error instanceof Error ? error.message.slice(0, 1000) : "unknown"],
    );
    await recordAudit({
      action: AUDIT.trainingFailed,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "model_run",
      resourceId: runId,
      outcome: "failure",
      metadata: { stage: "submit" },
    });
    throw error;
  }

  // The service identifies the run, and that id is unique here so two local runs
  // cannot end up pointing at the same service run. Re-submitting the same
  // preprocessing run can produce that, and it is a conflict to report rather
  // than a server fault: the person asked to train the same thing twice.
  try {
    await db.query(
      "UPDATE model_runs SET ml_run_id = $2 WHERE id = $1",
      [runId, serviceRun.run_id],
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23505") {
      await db.query(
        `UPDATE model_runs
            SET status = 'failed',
                stage = 'A training run for this preprocessing run already exists',
                error = $2,
                error_stage = 'submit',
                finished_at = now(),
                progress_percent = 100
          WHERE id = $1`,
        [
          runId,
          `The training service returned run ${serviceRun.run_id}, which is ` +
            "already recorded against another run. Preprocessing run " +
            `${record.ml_preprocessing_id} has already been trained.`,
        ],
      );
      throw AppError.conflict(
        "That dataset has already been trained from this preprocessing run.",
        "Start a new preprocessing run to train again, or open the existing run.",
      );
    }
    throw error;
  }

  await db.query("UPDATE datasets SET status = 'training' WHERE id = $1", [
    input.datasetId,
  ]);

  return (await getModelRun(runId)) as ModelRunSummary;
}

/**
 * Reconcile one run with the training service.
 *
 * Called by the run page while it polls. The service owns the progress and the
 * metrics, so the database row is brought into line with what it reports.
 */
export async function syncModelRun(runId: string): Promise<ModelRunSummary> {
  await requireActor();
  if (!isUuid(runId)) throw AppError.notFound("That training run does not exist.");
  const db = await getDatabase();

  const local = await db.query<RunRow & { ml_run_id: string | null }>(
    `${RUN_SELECT} WHERE r.id = $1`,
    [runId],
  );
  const row = local.rows[0];
  if (!row) throw AppError.notFound("That training run does not exist.");
  if (!row.ml_run_id) return toRunSummary(row);

  // Only pull from the service while the run is still in flight, or when it
  // just finished and results have not been copied down yet.
  const terminal = row.status === "completed" || row.status === "failed";
  if (terminal && Number(row.completed_count) > 0) {
    return toRunSummary(row);
  }

  let serviceRun: MlTrainingRun;
  try {
    serviceRun = await ml.trainingRun(row.ml_run_id);
  } catch {
    // The service being briefly unreachable must not lose the run. The stored
    // state is returned as-is and the page can offer a retry.
    return toRunSummary(row);
  }

  await db.query(
    `UPDATE model_runs
        SET status = $2, stage = $3, progress_percent = $4,
            started_at = COALESCE($5, started_at),
            finished_at = $6, duration_seconds = $7,
            error = $8, error_stage = $9, diagnostics = $10::jsonb
      WHERE id = $1`,
    [
      runId,
      serviceRun.status,
      serviceRun.stage,
      serviceRun.progress_percent,
      serviceRun.started_at,
      serviceRun.finished_at,
      serviceRun.duration_seconds,
      serviceRun.error,
      serviceRun.error_stage,
      JSON.stringify(serviceRun.diagnostics ?? {}),
    ],
  );

  for (const model of serviceRun.models) {
    await persistModelResult(runId, row.preprocessing_run_id, row.dataset_id, model);
  }

  if (serviceRun.status === "completed" || serviceRun.status === "failed") {
    const finished = await db.query<{ completed_count: string; failed_count: string }>(
      `SELECT
         (SELECT count(*) FROM model_results WHERE model_run_id = $1 AND status = 'completed')
           AS completed_count,
         (SELECT count(*) FROM model_results WHERE model_run_id = $1 AND status = 'failed')
           AS failed_count`,
      [runId],
    );
    await db.query(
      "UPDATE datasets SET status = $2 WHERE id = $1",
      [row.dataset_id, Number(finished.rows[0].completed_count) > 0 ? "ready" : "failed"],
    );
    await recordAudit({
      action:
        serviceRun.status === "completed"
          ? AUDIT.trainingCompleted
          : AUDIT.trainingFailed,
      resourceType: "model_run",
      resourceId: runId,
      outcome: serviceRun.status === "completed" ? "success" : "failure",
      metadata: {
        completed: Number(finished.rows[0].completed_count),
        failed: Number(finished.rows[0].failed_count),
        durationSeconds: serviceRun.duration_seconds,
      },
    });
  }

  return (await getModelRun(runId)) as ModelRunSummary;
}

async function persistModelResult(
  runId: string,
  preprocessingRunId: string,
  datasetId: string,
  model: MlModelResult,
): Promise<void> {
  const db = await getDatabase();
  const mlModelId =
    model.artifact_path ??
    (model.status === "completed" ? `${model.model_type}-${Date.now()}` : null);

  await db.query(
    `INSERT INTO model_results
       (model_run_id, model_type, display_name, status, version, ml_model_id,
        hyperparameters, grid_search,
        validation_metrics, validation_confusion, validation_roc,
        test_metrics, test_confusion, test_roc, decile_lift,
        error, error_stage, feature_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,
             $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18)
     ON CONFLICT (ml_model_id) DO UPDATE
       SET status = EXCLUDED.status,
           version = EXCLUDED.version,
           hyperparameters = EXCLUDED.hyperparameters,
           grid_search = EXCLUDED.grid_search,
           validation_metrics = EXCLUDED.validation_metrics,
           validation_confusion = EXCLUDED.validation_confusion,
           validation_roc = EXCLUDED.validation_roc,
           test_metrics = EXCLUDED.test_metrics,
           test_confusion = EXCLUDED.test_confusion,
           test_roc = EXCLUDED.test_roc,
           decile_lift = EXCLUDED.decile_lift,
           error = EXCLUDED.error,
           error_stage = EXCLUDED.error_stage,
           feature_count = EXCLUDED.feature_count`,
    [
      runId,
      model.model_type,
      model.display_name,
      model.status,
      mlModelId ? mlModelId.split("-").pop() ?? null : null,
      mlModelId,
      JSON.stringify(model.grid_search?.best_params ?? {}),
      JSON.stringify(model.grid_search ?? {}),
      model.validation?.metrics ? JSON.stringify(model.validation.metrics) : null,
      model.validation?.confusion_matrix
        ? JSON.stringify(model.validation.confusion_matrix)
        : null,
      null,
      model.test?.metrics ? JSON.stringify(model.test.metrics) : null,
      model.test?.confusion_matrix ? JSON.stringify(model.test.confusion_matrix) : null,
      model.test?.roc ? JSON.stringify(model.test.roc) : null,
      model.decile_lift ? JSON.stringify(model.decile_lift) : null,
      model.error,
      model.error_stage,
      null,
    ],
  );

  // Record the serialised pipeline and the rendered charts as artifacts.
  //
  // The path stored is the one the ML service reported, which lives on that
  // service's filesystem. It is recorded because it names the chart, and the
  // bytes are fetched over HTTP from the service rather than read from disk —
  // the two processes do not share a filesystem in a deployment.
  const modelResult = await db.query<{ id: string }>(
    "SELECT id FROM model_results WHERE ml_model_id = $1",
    [mlModelId],
  );
  const modelResultId = modelResult.rows[0]?.id;
  if (!modelResultId) return;

  if (mlModelId) {
    await recordArtifact(
      modelResultId,
      "model",
      mlModelId,
      null,
      "application/octet-stream",
    );
  }

  // The service reports chart paths on the run payload, and the prediction and
  // explanation payloads each name the charts for that model.
  for (const [kind, plotPath] of chartPathsFor(model)) {
    const name = plotName(plotPath);
    if (name) {
      await recordArtifact(modelResultId, kind, name, null, "image/png");
    }
  }

  void preprocessingRunId;
  void datasetId;
}

/**
 * The chart kinds a model result names.
 *
 * The training payload carries the ROC comparison for the whole run; the
 * per-model charts are named by the prediction and explanation payloads. A
 * result that names none simply has no charts recorded, and the interface says
 * so rather than showing a broken image.
 */
function chartPathsFor(model: MlModelResult): [string, string | null][] {
  const charts = model as unknown as Record<string, unknown>;
  const pairs: [string, string | null][] = [];
  const push = (kind: string, value: unknown) => {
    if (typeof value === "string" && value) pairs.push([kind, value]);
  };

  push("confusion_plot", charts.confusion_plot_path);
  push("roc_plot", charts.roc_plot_path);
  push("decile_plot", charts.decile_plot_path);
  push("beeswarm_plot", charts.beeswarm_plot_path);
  push("importance_plot", charts.importance_plot_path);

  return pairs;
}

async function recordArtifact(
  modelResultId: string,
  kind: string,
  storagePath: string,
  sizeBytes: number | null,
  contentType: string,
): Promise<void> {
  const db = await getDatabase();
  await db.query(
    `INSERT INTO model_artifacts
       (model_result_id, kind, storage_path, size_bytes, content_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (model_result_id, kind, storage_path) DO UPDATE
       SET size_bytes = EXCLUDED.size_bytes,
           content_type = EXCLUDED.content_type`,
    [modelResultId, kind, storagePath, sizeBytes, contentType],
  );
}

export async function getModelRun(runId: string): Promise<ModelRunSummary | null> {
  await requireActor();
  if (!isUuid(runId)) return null;
  const db = await getDatabase();
  const result = await db.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [runId]);
  return result.rows[0] ? toRunSummary(result.rows[0]) : null;
}

/** Every model produced by one run, in the order they finished. */
export async function listModelsForRun(
  runId: string,
): Promise<ModelResultSummary[]> {
  await requireActor();
  if (!isUuid(runId)) return [];
  const db = await getDatabase();
  const result = await db.query<ModelRow>(
    `${MODEL_SELECT} WHERE m.model_run_id = $1 ORDER BY m.created_at`,
    [runId],
  );
  return result.rows.map(toModelSummary);
}

export async function listModelRuns(limit = 25): Promise<ModelRunSummary[]> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<RunRow>(
    `${RUN_SELECT} ORDER BY r.created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toRunSummary);
}

interface ModelRow {
  id: string;
  model_run_id: string;
  model_type: ModelType;
  display_name: string;
  status: ModelStatus;
  version: string | null;
  ml_model_id: string | null;
  is_active: boolean;
  activated_at: string | null;
  activated_by_name: string | null;
  activation_reason: string | null;
  hyperparameters: Record<string, unknown>;
  grid_search: Record<string, unknown>;
  validation_metrics: Record<string, number> | null;
  validation_confusion: Record<string, number> | null;
  test_metrics: Record<string, number> | null;
  test_confusion: Record<string, number> | null;
  test_roc: Record<string, unknown> | null;
  decile_lift: Record<string, unknown> | null;
  error: string | null;
  error_stage: string | null;
  created_at: string;
  train_duration_seconds: string | null;
  feature_count: number | null;
  dataset_id: string;
  dataset_name: string | null;
  preprocessing_run_id: string;
  preprocessing_version: string | null;
}

const MODEL_SELECT = `
  SELECT m.*, a.full_name AS activated_by_name,
         r.dataset_id, d.name AS dataset_name, r.preprocessing_run_id,
         p.ml_preprocessing_id AS preprocessing_version
    FROM model_results m
    JOIN model_runs r ON r.id = m.model_run_id
    LEFT JOIN datasets d ON d.id = r.dataset_id
    LEFT JOIN preprocessing_runs p ON p.id = r.preprocessing_run_id
    LEFT JOIN users a ON a.id = m.activated_by
`;

function toModelSummary(row: ModelRow): ModelResultSummary {
  const grid = row.grid_search ?? {};
  return {
    id: row.id,
    modelRunId: row.model_run_id,
    modelType: row.model_type,
    displayName: row.display_name,
    status: row.status,
    version: row.version,
    mlModelId: row.ml_model_id,
    isActive: row.is_active,
    activatedAt: row.activated_at,
    activatedByName: row.activated_by_name,
    activationReason: row.activation_reason,
    hyperparameters: row.hyperparameters ?? {},
    cvScore:
      typeof grid.best_cv_score === "number" ? grid.best_cv_score : null,
    testMetrics: row.test_metrics,
    testConfusion: row.test_confusion,
    decileLift: row.decile_lift,
    error: row.error,
    errorStage: row.error_stage,
    createdAt: row.created_at,
  };
}

export async function listModels(
  options: { onlyActive?: boolean; modelType?: ModelType } = {},
): Promise<ModelResultSummary[]> {
  await requireActor();
  const db = await getDatabase();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.onlyActive) clauses.push("m.is_active");
  if (options.modelType) {
    params.push(options.modelType);
    clauses.push(`m.model_type = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db.query<ModelRow>(
    `${MODEL_SELECT} ${where} ORDER BY m.created_at DESC`,
    params,
  );
  return result.rows.map(toModelSummary);
}

export async function getModel(
  modelId: string,
): Promise<ModelDetail | null> {
  await requireActor();
  if (!isUuid(modelId)) return null;
  const db = await getDatabase();
  const result = await db.query<ModelRow>(`${MODEL_SELECT} WHERE m.id = $1`, [
    modelId,
  ]);
  const row = result.rows[0];
  if (!row) return null;

  const artifacts = await db.query<{
    id: string;
    kind: string;
    storage_path: string;
    size_bytes: string | null;
    content_type: string;
  }>("SELECT * FROM model_artifacts WHERE model_result_id = $1", [modelId]);

  const reviews = await db.query<{
    id: string;
    feature: string;
    concern_type: string;
    severity: string;
    mean_abs_shap: string | null;
    status: string;
    notes: string | null;
    reviewer_name: string | null;
    reviewed_at: string | null;
    created_at: string;
  }>(
    `SELECT rr.*, u.full_name AS reviewer_name
       FROM model_risk_reviews rr
       LEFT JOIN users u ON u.id = rr.reviewed_by
      WHERE rr.model_result_id = $1
      ORDER BY rr.created_at`,
    [modelId],
  );

  const grid = row.grid_search ?? {};
  const testNotes = Array.isArray((row.test_roc as { notes?: string[] })?.notes)
    ? ((row.test_roc as { notes: string[] }).notes ?? [])
    : [];

  return {
    ...toModelSummary(row),
    gridSearch: grid,
    validationMetrics: row.validation_metrics,
    validationConfusion: row.validation_confusion,
    testRoc: row.test_roc,
    testNotes,
    validationNotes: [],
    trainDurationSeconds: row.train_duration_seconds
      ? Number(row.train_duration_seconds)
      : null,
    featureCount: row.feature_count,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    preprocessingRunId: row.preprocessing_run_id,
    preprocessingVersion: row.preprocessing_version,
    artifacts: artifacts.rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      storagePath: a.storage_path,
      sizeBytes: a.size_bytes ? Number(a.size_bytes) : null,
      contentType: a.content_type,
    })),
    riskReviews: reviews.rows.map((r) => ({
      id: r.id,
      feature: r.feature,
      concernType: r.concern_type,
      severity: r.severity,
      meanAbsShap: r.mean_abs_shap ? Number(r.mean_abs_shap) : null,
      status: r.status,
      notes: r.notes,
      reviewedByName: r.reviewer_name,
      reviewedAt: r.reviewed_at,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Fetch one of a model's rendered charts.
 *
 * The recorded path names a file on the machine learning service's filesystem.
 * It cannot be read from here, so the chart is requested from that service by
 * name and the bytes are returned for the caller to stream. A chart that the
 * service no longer has returns null rather than an error: a missing chart is a
 * cosmetic gap, and the interface says so instead of showing a broken image.
 */
export async function getModelChart(
  modelId: string,
  kind: ModelChartKind,
): Promise<{ bytes: Buffer; filename: string } | null> {
  await requireActor();
  if (!isUuid(modelId)) return null;

  const db = await getDatabase();
  const artifact = await db.query<{ storage_path: string }>(
    `SELECT storage_path FROM model_artifacts
      WHERE model_result_id = $1 AND kind = $2
      ORDER BY created_at DESC LIMIT 1`,
    [modelId, kind],
  );
  const path = artifact.rows[0]?.storage_path;
  if (!path) return null;

  let bytes: Buffer | null;
  try {
    bytes = await ml.plot(path);
  } catch {
    // The service being unreachable must not take the model page down with it.
    return null;
  }
  if (!bytes || bytes.byteLength === 0) return null;

  return { bytes, filename: CHART_FILENAMES[kind] };
}

/** Which charts a model has recorded, for deciding what to render. */
export async function listModelCharts(
  modelId: string,
): Promise<ModelChartKind[]> {
  await requireActor();
  if (!isUuid(modelId)) return [];
  const db = await getDatabase();
  const rows = await db.query<{ kind: string }>(
    "SELECT DISTINCT kind FROM model_artifacts WHERE model_result_id = $1",
    [modelId],
  );
  const known = new Set<string>(Object.values(ModelChartKind));
  return rows.rows
    .map((row) => row.kind)
    .filter((kind): kind is ModelChartKind => known.has(kind));
}

/** Activate a model for prediction, deactivating the previous one of its type. */
export async function activateModel(
  modelId: string,  reason: string,
): Promise<ModelResultSummary> {
  const actor: Actor = await requireCapability("activateModels");
  if (!isUuid(modelId)) throw AppError.notFound("That model does not exist.");
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw AppError.unprocessable("Give a short reason for activating this model.", {
      fields: { reason: "Explain in a few words why this model is being activated." },
    });
  }

  const db = await getDatabase();
  const target = await db.query<ModelRow>(`${MODEL_SELECT} WHERE m.id = $1`, [
    modelId,
  ]);
  const model = target.rows[0];
  if (!model) throw AppError.notFound("That model does not exist.");
  if (model.status !== "completed") {
    throw AppError.unprocessable(
      "Only a model that finished training can be activated.",
      { nextAction: "Wait for training to finish, or train a new model." },
    );
  }
  if (model.is_active) {
    throw AppError.conflict("That model is already active.");
  }

  const previous = await db.query<{ id: string; ml_model_id: string | null }>(
    `SELECT id, ml_model_id FROM model_results
      WHERE model_type = $1 AND is_active`,
    [model.model_type],
  );

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE model_results SET is_active = false WHERE model_type = $1 AND is_active`,
      [model.model_type],
    );
    await tx.query(
      `UPDATE model_results
          SET is_active = true, activated_at = now(), activated_by = $2,
              activation_reason = $3
        WHERE id = $1`,
      [modelId, actor.id, trimmed],
    );
  });

  await recordAudit({
    action: AUDIT.modelActivated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "model",
    resourceId: modelId,
    metadata: {
      modelType: model.model_type,
      mlModelId: model.ml_model_id,
      reason: trimmed,
      replaced: previous.rows.map((r) => r.ml_model_id ?? r.id),
      testMetrics: model.test_metrics,
    },
  });

  return toModelSummary(model);
}

export async function deactivateModel(modelId: string): Promise<void> {
  const actor = await requireCapability("activateModels");
  const db = await getDatabase();
  const result = await db.query(
    `UPDATE model_results
        SET is_active = false, activated_at = NULL, activated_by = NULL,
            activation_reason = NULL
      WHERE id = $1 AND is_active RETURNING id`,
    [modelId],
  );
  if (!result.rows.length) {
    throw AppError.notFound("That model is not currently active.");
  }
  await recordAudit({
    action: AUDIT.modelDeactivated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "model",
    resourceId: modelId,
  });
}

/** The model currently serving predictions of a given family, if any. */
export async function activeModelForType(
  modelType: ModelType,
): Promise<ModelResultSummary | null> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<ModelRow>(
    `${MODEL_SELECT} WHERE m.is_active AND m.model_type = $1`,
    [modelType],
  );
  return result.rows[0] ? toModelSummary(result.rows[0]) : null;
}

/** The default model used when a caller does not name one. */
export async function defaultActiveModel(): Promise<ModelResultSummary | null> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<ModelRow>(
    `${MODEL_SELECT} WHERE m.is_active ORDER BY m.activated_at DESC LIMIT 1`,
  );
  return result.rows[0] ? toModelSummary(result.rows[0]) : null;
}

export interface RiskReviewInput {
  feature: string;
  concernType: "proxy_risk" | "questionable_variable" | "bias_concern" | "needs_review";
  severity: "low" | "medium" | "high";
  meanAbsShap?: number | null;
  notes?: string | null;
}

export async function flagRisk(
  modelId: string,
  input: RiskReviewInput,
): Promise<RiskReviewSummary> {
  const actor = await requireCapability("manageModels");
  if (!isUuid(modelId)) throw AppError.notFound("That model does not exist.");
  const db = await getDatabase();
  const result = await db.query<{ id: string }>(
    `INSERT INTO model_risk_reviews
       (model_result_id, feature, concern_type, severity, mean_abs_shap, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (model_result_id, feature, concern_type) DO UPDATE
       SET severity = EXCLUDED.severity, notes = EXCLUDED.notes,
           mean_abs_shap = EXCLUDED.mean_abs_shap
     RETURNING id`,
    [
      modelId,
      input.feature.slice(0, 200),
      input.concernType,
      input.severity,
      input.meanAbsShap ?? null,
      input.notes ?? null,
    ],
  );

  await recordAudit({
    action: AUDIT.modelReviewed,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "model",
    resourceId: modelId,
    metadata: { feature: input.feature, concernType: input.concernType },
  });

  const saved = await db.query<{ id: string }>(
    "SELECT id FROM model_risk_reviews WHERE id = $1",
    [result.rows[0].id],
  );
  const detail = await getModel(modelId);
  const review = detail?.riskReviews.find((r) => r.id === saved.rows[0].id);
  if (!review) throw AppError.internal("The review could not be read back.");
  return review;
}

export async function resolveRiskReview(
  reviewId: string,
  input: { status: "under_review" | "accepted" | "rejected" | "mitigated"; notes?: string },
): Promise<void> {
  const actor = await requireCapability("manageModels");
  if (!isUuid(reviewId)) throw AppError.notFound("That review does not exist.");
  const db = await getDatabase();
  const result = await db.query(
    `UPDATE model_risk_reviews
        SET status = $2, notes = COALESCE($3, notes), reviewed_by = $4,
            reviewed_at = now()
      WHERE id = $1 RETURNING model_result_id`,
    [reviewId, input.status, input.notes ?? null, actor.id],
  );
  if (!result.rows.length) {
    throw AppError.notFound("That review does not exist.");
  }
  await recordAudit({
    action: AUDIT.modelReviewed,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "model",
    resourceId: result.rows[0].model_result_id as string,
    metadata: { reviewId, status: input.status },
  });
}

/** The dataset's stored file, for the prediction and explanation calls. */
export async function modelSourceFile(
  modelId: string,
): Promise<{ buffer: Buffer; filename: string; datasetId: string }> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<{
    storage_path: string;
    original_filename: string;
    dataset_id: string;
  }>(
    `SELECT d.storage_path, d.original_filename, r.dataset_id
       FROM model_results m
       JOIN model_runs r ON r.id = m.model_run_id
       JOIN datasets d ON d.id = r.dataset_id
      WHERE m.id = $1`,
    [modelId],
  );
  const row = result.rows[0];
  if (!row) throw AppError.notFound("That model does not exist.");
  return {
    buffer: await readDatasetFile(row.storage_path),
    filename: row.original_filename,
    datasetId: row.dataset_id,
  };
}
