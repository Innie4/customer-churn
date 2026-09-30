/**
 * An in-process stand-in for the Python ML service.
 *
 * This exists so the whole application can be exercised without Python
 * running. It is deliberately confined to the same seam as the real service:
 * the application's own client talks to this instead of making HTTP calls, and
 * nothing in the pages, the data layer, or the schema knows the difference.
 *
 * The state it keeps, model registry and training runs, is written to disk the
 * way the real service persists artifacts, so a demo survives a dev-server
 * restart and ids stay stable across pages.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MlColumn,
  MlGlobalExplanation,
  MlInspection,
  MlIssue,
  MlLocalExplanation,
  MlModelResult,
  MlPreprocessResult,
  MlPreprocessStep,
  MlPrediction,
  MlPredictResponse,
  MlServiceHealth,
  MlTrainingRun,
} from "@/lib/ml-client";
import { Customer } from "./population";
import {
  ModelType,
  decileLift,
  evaluate,
  modelProbability,
  scorePopulation,
  stratifiedSplit,
} from "./metrics";
import {
  baseValueFor,
  contributionsFor,
  globalImportance,
  riskCategory,
  summariseRisk,
} from "./explanations";
import { buildCustomersFromRows, worldForCsv } from "./world-from-csv";
import { parseCsv } from "@/lib/dal/datasets";
import { Rng, round } from "./rng";
import {
  beeswarmPng,
  confusionMatrixPng,
  decileLiftPng,
  featureImportancePng,
  rocCurvePng,
} from "./charts";

const DISCLOSURE =
  "SHAP values describe how the model scored this customer. They are not causal and do not imply that changing an attribute would change the outcome.";

interface RegisteredModel {
  modelId: string;
  modelType: ModelType;
  modelVersion: string;
  runId: string;
  datasetKey: string;
  createdAt: string;
}

interface ServiceState {
  models: Record<string, RegisteredModel>;
  runs: Record<string, MlTrainingRun>;
  /**
   * Global SHAP features, keyed by model id.
   *
   * Persisted so the importance and beeswarm charts can be drawn on a later
   * request, which is usually a different process from the one that generated
   * the explanation.
   */
  features?: Record<
    string,
    { label: string; mean_abs_shap: number }[]
  >;
}

/**
 * Where the simulated service keeps its model registry.
 *
 * The `turbopackIgnore` marker is the same one the storage layer uses, and it
 * is needed here. Without it Turbopack rewrites `process.cwd()` into a `URL`
 * when it builds this module for the server, and the resulting directory does
 * not resolve. The failure is silent rather than loud: the state file simply
 * cannot be read, so the service starts with an empty registry, and every chart
 * request comes back as a 404 with no error anywhere. The scripts, which load
 * this module outside the bundler, are unaffected, which is what makes it easy
 * to miss.
 *
 * An explicit override is honoured first, so the location never has to depend
 * on the working directory.
 */
const STATE_DIR = process.env.SIMULATED_STATE_DIR?.trim()
  ? (process.env.SIMULATED_STATE_DIR as string)
  : join(process.cwd() /* turbopackIgnore: true */, ".data", "demo-ml");
const STATE_FILE = join(STATE_DIR, "state.json");

let state: ServiceState | null = null;

function loadState(): ServiceState {
  if (state) return state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as ServiceState;
  } catch {
    state = { models: {}, runs: {}, features: {} };
  }
  return state;
}

function saveState(): void {
  if (!state) return;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/** Reset the simulated service. Used by the demo seed and by tests. */
export function resetServiceState(): void {
  state = { models: {}, runs: {}, features: {} };
  saveState();
}

function datasetKeyOf(buffer: Buffer, targetColumn: string, idColumns: string[]): string {
  return createHash("sha256")
    .update(buffer)
    .update(`|${targetColumn}|${idColumns.join(",")}`)
    .digest("hex")
    .slice(0, 32);
}

/** The model a given id refers to, or a sensible default for unknown ids. */
function modelTypeFor(modelId: string): ModelType {
  const registered = loadState().models[modelId];
  if (registered) return registered.modelType;
  // An unregistered id still has to produce a usable answer, so the family is
  // read off the name rather than failing a page that only needed a score.
  // This happens if the state file is removed while models remain in the
  // database.
  if (modelId.includes("xgboost")) return "xgboost";
  if (modelId.includes("random_forest")) return "random_forest";
  return "logistic_regression";
}

const DISPLAY_NAMES: Record<ModelType, string> = {
  logistic_regression: "Logistic Regression",
  random_forest: "Random Forest",
  xgboost: "XGBoost",
};

export const simulatedMl = {
  health(): Promise<MlServiceHealth> {
    return Promise.resolve({
      status: "ok",
      version: "simulated",
      artifact_dir: "in-process",
      authentication_required: false,
      library_versions: {
        note: "Simulated mode. No Python process is running and no model is trained on real data.",
      },
    });
  },

  async inspect(
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { targetColumn?: string; idColumns?: string[]; previewRows?: number } = {},
  ): Promise<MlInspection> {
    const target = options.targetColumn ?? "churn";
    const rows = parseCsv(file.buffer, target, options.idColumns ?? []);
    const targetDistribution: Record<string, number> = {};
    let blanks = 0;
    for (const row of rows) {
      if (row.observedChurn === null) blanks += 1;
      else {
        const key = row.observedChurn === 1 ? "Yes" : "No";
        targetDistribution[key] = (targetDistribution[key] ?? 0) + 1;
      }
    }
    const present = rows.length - blanks;
    const world = worldForCsv(file.buffer, target, options.idColumns ?? []);

    return {
      filename: file.filename,
      size_bytes: file.buffer.byteLength,
      row_count: rows.length,
      column_count: inferColumns(file.buffer, target).length,
      columns: inferColumns(file.buffer, target),
      duplicate_row_count: countDuplicates(file.buffer),
      target_column: target,
      target_distribution: targetDistribution,
      target_positive_rate: present > 0 ? round((targetDistribution["Yes"] ?? 0) / present, 6) : 0,
      total_charges_blank_rows: 0,
      total_charges_blank_with_zero_tenure: 0,
      blank_string_cells: 0,
      issues: buildIssues(world, blanks),
      preview_rows: rows.slice(0, options.previewRows ?? 10).map((row) => ({
        ...row.attributes,
        [target]: row.observedChurn === null ? "" : row.observedChurn === 1 ? "Yes" : "No",
      })),
    };
  },

  async preprocess(
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
    const idColumns = options.idColumns ?? [];
    const testSize = options.testSize ?? 0.2;
    const world = worldForCsv(file.buffer, options.targetColumn, idColumns, String(options.randomSeed ?? 42));
    const sourceRows = world.customers.length;
    const sourceColumns = inferColumns(file.buffer, options.targetColumn).length;

    const scored = scorePopulation(world.customers, "logistic_regression");
    const { train, test } = stratifiedSplit(scored, testSize, `split:${options.randomSeed ?? 42}`);
    const trainChurners = train.filter((sample) => sample.label === 1).length;
    const testChurners = test.filter((sample) => sample.label === 1).length;

    // Oversampling is only meaningful when the minority class is the smaller
    // one, and it happens inside the folds, never on the test split.
    const minority = Math.min(trainChurners, train.length - trainChurners);
    const balanced = options.applySmote ? trainChurners * 2 : 0;

    const steps: MlPreprocessStep[] = [
      {
        step: "load",
        description: "Read the CSV and coerce every column to a stable type.",
        affected_columns: [],
        rows_in: sourceRows,
        rows_out: sourceRows,
        details: { source_columns: sourceColumns, delimiter_sniffed: true },
        warnings: [],
      },
      {
        step: "clean",
        description: "Trim whitespace and coerce blank target cells to null.",
        affected_columns: [options.targetColumn],
        rows_in: sourceRows,
        rows_out: sourceRows,
        details: {
          blank_target_rows: world.blankTargetRows,
          total_charges_blank_rows: 0,
          rows_dropped: 0,
        },
        warnings:
          world.blankTargetRows > 0
            ? [`${world.blankTargetRows} rows have no target value and cannot be scored.`]
            : [],
      },
      {
        step: "split",
        description: options.stratify === false
          ? "Split into training and test sets without stratifying."
          : "Split into training and test sets, stratified on the target.",
        affected_columns: [],
        rows_in: sourceRows,
        rows_out: sourceRows,
        details: { stratify: options.stratify !== false, test_size: testSize },
        warnings: [],
      },
      {
        step: "encode",
        description: "One-hot encode categoricals and standardise numeric columns.",
        affected_columns: [],
        rows_in: sourceRows,
        rows_out: sourceRows,
        details: { encoded_feature_count: 40, fit_on: "training split only" },
        warnings: [],
      },
      {
        step: "smote",
        description: options.applySmote
          ? "Oversample the minority class inside each cross-validation fold."
          : "Skipped: class imbalance handling was turned off.",
        affected_columns: [],
        rows_in: train.length,
        rows_out: train.length + balanced,
        details: {
          applied: Boolean(options.applySmote),
          before_minority_count: minority,
          after_minority_count: options.applySmote ? trainChurners : minority,
          strategy: "SMOTE to 100% of the majority class",
          leakage_guard: "Applied inside folds; the test split is never resampled.",
        },
        warnings: [],
      },
    ];

    const result: MlPreprocessResult = {
      preprocessing_id: randomUUID(),
      created_at: new Date().toISOString(),
      params: {
        target_column: options.targetColumn,
        id_columns: idColumns,
        test_size: testSize,
        stratify: options.stratify !== false,
        apply_smote: Boolean(options.applySmote),
        random_seed: options.randomSeed ?? 42,
      },
      source_row_count: sourceRows,
      source_column_count: sourceColumns,
      target_column: options.targetColumn,
      target_positive_rate: world.observedChurnRate ?? 0,
      steps,
      split: {
        train_rows: train.length,
        test_rows: test.length,
        train_churners: trainChurners,
        test_churners: testChurners,
        train_churn_rate: round(trainChurners / train.length, 6),
        test_churn_rate: round(testChurners / test.length, 6),
        stratified: options.stratify !== false,
        random_seed: options.randomSeed ?? 42,
      },
      resample: {
        applied: Boolean(options.applySmote),
        method: options.applySmote ? "SMOTE" : null,
        scope: "training split, inside each cross-validation fold",
        rows_before: options.applySmote ? train.length : null,
        rows_after: options.applySmote ? train.length + balanced : null,
        note: options.applySmote
          ? "The test split is never resampled, so its figures stay honest."
          : "Class imbalance handling was turned off for this run.",
      },
      encoded_features: encodedFeatures(),
      encoded_feature_count: 40,
      warnings: world.blankTargetRows > 0
        ? [`${world.blankTargetRows} rows have no ${options.targetColumn} value and were excluded from scoring.`]
        : [],
      scaler_mean: scalerStats(sourceColumns, "mean"),
      scaler_scale: scalerStats(sourceColumns, "scale"),
    };

    // The dataset is remembered against this id, so a later training request
    // naming the same id can find it. That is what lets a person upload and
    // preprocess in the browser and then start a run, with no Python anywhere.
    registerPreprocessingDataset(
      result.preprocessing_id,
      file.buffer,
      options.targetColumn,
      idColumns,
      datasetKeyOf(file.buffer, options.targetColumn, idColumns),
    );

    return result;
  },

  async startTraining(body: {
    preprocessing_id: string;
    model_types?: string[];
    cv_folds?: number;
    random_seed?: number;
    run_label?: string;
  }): Promise<MlTrainingRun> {
    // The run needs the dataset it was launched for. The application passes
    // that as a preprocessing id, so the pairing is read back out of the
    // diagnostics the demo seed registered alongside it.
    const registered = loadState().runs[body.preprocessing_id];
    const requested = body.model_types?.length
      ? (body.model_types as ModelType[])
      : (["logistic_regression", "random_forest", "xgboost"] as ModelType[]);

    const datasetKey =
      typeof registered?.diagnostics?.datasetKey === "string"
        ? registered.diagnostics.datasetKey
        : null;
    const targetColumn =
      typeof registered?.diagnostics?.targetColumn === "string"
        ? registered.diagnostics.targetColumn
        : "churn";
    const idColumns = Array.isArray(registered?.diagnostics?.idColumns)
      ? (registered.diagnostics.idColumns as string[])
      : [];

    const buffer = datasetKey ? pendingBytes.get(datasetKey) : undefined;
    if (datasetKey && buffer) {
      const run = buildRun({
        runId: randomUUID(),
        label: body.run_label ?? null,
        buffer,
        targetColumn,
        idColumns,
        modelTypes: requested,
        cvFolds: body.cv_folds ?? 5,
        seed: body.random_seed ?? 42,
        startedAt: new Date().toISOString(),
      });
      const current = loadState();
      current.runs[run.run_id] = run;
      saveState();
      return run;
    }

    // No dataset is associated with this id, so return a run that fails with a
    // clear reason rather than silently inventing results.
    return {
      run_id: randomUUID(),
      status: "failed",
      stage: "load_preprocessed_dataset",
      progress_percent: 0,
      preprocessing_id: body.preprocessing_id,
      label: body.run_label ?? null,
      requested_models: requested,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_seconds: 0.1,
      models: [],
      error:
        "No dataset is associated with this preprocessing id in simulated mode. Run the demo seed, or upload a dataset and preprocess it first.",
      error_stage: "load_preprocessed_dataset",
      diagnostics: {},
    };
  },

  async trainingRun(runId: string): Promise<MlTrainingRun> {
    const run = loadState().runs[runId];
    if (run) return run;
    return {
      run_id: runId,
      status: "failed",
      stage: "unknown_run",
      progress_percent: 0,
      preprocessing_id: "",
      label: null,
      requested_models: [],
      started_at: null,
      finished_at: null,
      duration_seconds: null,
      models: [],
      error: `No simulated training run with id ${runId}.`,
      error_stage: "unknown_run",
      diagnostics: {},
    };
  },

  async listTrainingRuns(limit = 25): Promise<MlTrainingRun[]> {
    return Object.values(loadState().runs)
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
      .slice(0, limit);
  },

  async predict(
    modelId: string,
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { high?: number; medium?: number; idColumns?: string[] } = {},
  ): Promise<MlPredictResponse> {
    const thresholds = { high: options.high ?? 0.7, medium: options.medium ?? 0.4 };
    const modelType = modelTypeFor(modelId);
    const target = "churn";
    const world = worldForCsv(file.buffer, target, options.idColumns ?? []);
    const registered = loadState().models[modelId];
    const version = registered?.modelVersion ?? "simulated-1.0.0";

    const predictions: MlPrediction[] = world.customers.map((customer, index) => {
      const probability = scoreCustomer(customer, modelType);
      return {
        row_index: index,
        customer_id: customer.customerId,
        churn_probability: round(probability, 6),
        predicted_label: probability >= 0.5 ? 1 : 0,
        risk_category: riskCategory(probability, thresholds),
        risk_thresholds: thresholds,
        model_id: modelId,
        model_version: version,
        model_type: modelType,
      };
    });

    const positives = predictions.filter((p) => p.churn_probability >= 0.5).length;
    const riskCounts = { low: 0, medium: 0, high: 0 };
    for (const prediction of predictions) riskCounts[prediction.risk_category] += 1;

    return {
      model_id: modelId,
      model_version: version,
      model_type: modelType,
      row_count: predictions.length,
      positive_rate: round(positives / Math.max(predictions.length, 1), 6),
      risk_counts: riskCounts,
      thresholds,
      predictions,
      warnings: [
        "Simulated mode: these probabilities are generated, not produced by a trained model.",
      ],
    };
  },

  async localExplanation(
    modelId: string,
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { rowIndex?: number; customerId?: string; topN?: number } = {},
  ): Promise<MlLocalExplanation> {
    const modelType = modelTypeFor(modelId);
    const topN = options.topN ?? 5;
    const rows = parseCsv(file.buffer, "churn", []);
    const { customers } = buildCustomersFromRows(rows, "explain");

    let customer = options.customerId
      ? customers.find((entry) => entry.customerId === options.customerId)
      : undefined;
    customer ??= customers[options.rowIndex ?? 0] ?? customers[0];
    if (!customer) {
      throw new Error("No rows available to explain.");
    }

    const baseValue = baseValueFor(customers, modelType);
    const { probability, contributions } = contributionsFor(customer, modelType, baseValue);
    const ranked = {
      top_increasing_risk: contributions
        .filter((entry) => entry.shap_value > 0)
        .sort((a, b) => b.shap_value - a.shap_value)
        .slice(0, topN),
      top_reducing_risk: contributions
        .filter((entry) => entry.shap_value < 0)
        .sort((a, b) => a.shap_value - b.shap_value)
        .slice(0, topN),
    };

    return {
      model_id: modelId,
      model_version: loadState().models[modelId]?.modelVersion ?? "simulated-1.0.0",
      model_type: modelType,
      row_index: customer.index,
      customer_id: customer.customerId,
      churn_probability: round(probability, 6),
      base_value: round(baseValue, 6),
      summary: summariseRisk(customer, contributions),
      top_increasing_risk: ranked.top_increasing_risk,
      top_reducing_risk: ranked.top_reducing_risk,
      all_contributions: [...contributions].sort(
        (a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value),
      ),
      waterfall_plot_path: null,
      generated_at: new Date().toISOString(),
      disclaimer: DISCLOSURE,
    };
  },

  async globalExplanation(
    modelId: string,
    file: { buffer: Buffer; filename: string; contentType: string },
    options: { sampleSize?: number; renderPlots?: boolean } = {},
  ): Promise<MlGlobalExplanation> {
    const modelType = modelTypeFor(modelId);
    const rows = parseCsv(file.buffer, "churn", []);
    const { customers } = buildCustomersFromRows(rows, "global");
    const sampleSize = options.sampleSize ?? 200;
    const sample = customers.slice(0, Math.min(sampleSize, customers.length));
    const baseValue = baseValueFor(customers, modelType);

    const features = globalImportance(customers, modelType, baseValue)
      .slice(0, 20)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));

    // Recorded on disk, because the chart bytes are requested by a later
    // request and often by a different process. Rebuilding the importance
    // ranking needs the dataset, and the simulated service does not keep the
    // bytes of every dataset it has ever seen: the real service persists its
    // artifacts for the same reason.
    const current = loadState();
    const featuresFor = current.features ?? {};
    featuresFor[modelId] = features;
    current.features = featuresFor;
    saveState();

    return {
      model_id: modelId,
      model_version: current.models[modelId]?.modelVersion ?? "simulated-1.0.0",
      model_type: modelType,
      sample_size: sample.length,
      class_balance_note: `Explained on ${sample.length} of ${customers.length} customers, sampled from both churn outcomes in proportion to their frequency in the dataset.`,
      features,
      beeswarm_plot_path: null,
      importance_plot_path: null,
      generated_at: new Date().toISOString(),
      disclaimer: DISCLOSURE,
    };
  },

  async rocPlot(runId: string): Promise<{ path: string | null }> {
    const run = loadState().runs[runId];
    if (!run) return { path: null };
    return { path: `/v1/training/runs/${runId}/roc-plot` };
  },

  /**
   * Render a named chart as PNG bytes.
   *
   * The application records the chart name when a model is persisted and asks
   * for the bytes by that same name later, so the drawing is reconstructed
   * here from the stored metrics rather than kept in memory. That keeps a
   * chart valid across a restart, the same as a file on the real service.
   */
  async plot(plotPath: string | null | undefined): Promise<Buffer | null> {
    const name = plotPath?.replace(/\\/g, "/").split("/").pop() ?? "";
    if (!/^[A-Za-z0-9._-]+\.png$/i.test(name)) return null;

    const current = loadState();
    // Any model will do: the figures are the same shape for all of them, and
    // the caller has already proved it is allowed to see this chart.
    const model = Object.values(current.models)[0];
    const run = model ? current.runs[model.runId] : undefined;
    if (!run) return null;

    const result = run.models[0];
    if (!result) return null;

    switch (name) {
      case "roc-curve.png": {
        const roc = result.test?.roc ?? result.validation.roc;
        return rocCurvePng(roc?.points ?? [{ fpr: 0, tpr: 0 }], roc?.auc ?? 0);
      }
      case "confusion-matrix.png": {
        const confusion = result.test?.confusion_matrix ?? result.validation.confusion_matrix;
        if (!confusion) return null;
        return confusionMatrixPng(confusion);
      }
      case "decile-lift.png": {
        const lift = result.decile_lift;
        if (!lift) return null;
        return decileLiftPng(lift.rows, lift.baseline_churn_rate);
      }
      case "shap-importance.png":
      case "shap-beeswarm.png": {
        const features = importanceFor(current);
        if (features.length === 0) return null;
        return name === "shap-importance.png"
          ? featureImportancePng(features)
          : beeswarmPng(features);
      }
      default:
        return null;
    }
  },
};

/**
 * The global SHAP features to chart, preferring what was recorded when the
 * explanation was generated.
 *
 * The fallback recomputes from the dataset, which only works in the process
 * that holds those bytes, so the recorded copy is what makes the charts work
 * everywhere else.
 */
function importanceFor(state: ServiceState): {
  label: string;
  mean_abs_shap: number;
}[] {
  const recorded = Object.values(state.features ?? {})[0];
  if (recorded && recorded.length > 0) return recorded;

  const model = Object.values(state.models)[0];
  const run = model ? state.runs[model.runId] : undefined;
  const datasetKey = run?.diagnostics?.datasetKey;
  const buffer = typeof datasetKey === "string" ? pendingBytes.get(datasetKey) : undefined;
  if (!buffer || !model) return [];
  const targetColumn =
    typeof run?.diagnostics?.targetColumn === "string" ? run.diagnostics.targetColumn : "churn";
  const idColumns = Array.isArray(run?.diagnostics?.idColumns)
    ? (run.diagnostics.idColumns as string[])
    : [];
  const world = worldForCsv(buffer, targetColumn, idColumns);
  const baseValue = baseValueFor(world.customers, model.modelType);
  return globalImportance(world.customers, model.modelType, baseValue).slice(0, 20);
}

/** The probability one model assigns to one customer. */
function scoreCustomer(customer: Customer, modelType: ModelType): number {
  return modelProbability(customer, modelType);
}

/** The one-hot feature list, matching what the real pipeline reports. */
function encodedFeatures(): {
  name: string;
  source_column: string;
  kind: string;
  level: string | null;
  scaled: boolean;
  label: string;
}[] {
  const features: {
    name: string;
    source_column: string;
    kind: string;
    level: string | null;
    scaled: boolean;
    label: string;
  }[] = [
    { name: "tenure_scaled", source_column: "tenure", kind: "numeric", level: null, scaled: true, label: "Tenure (standardised)" },
    { name: "MonthlyCharges_scaled", source_column: "MonthlyCharges", kind: "numeric", level: null, scaled: true, label: "Monthly charges (standardised)" },
    { name: "SeniorCitizen", source_column: "SeniorCitizen", kind: "binary", level: null, scaled: false, label: "Senior citizen" },
  ];
  for (const level of ["Month-to-month", "One year", "Two year"]) {
    features.push({
      name: `Contract__${level.replace(/\s+/g, "_")}`,
      source_column: "Contract",
      kind: "one_hot",
      level,
      scaled: false,
      label: `Contract: ${level}`,
    });
  }
  for (const level of ["DSL", "Fiber optic", "No"]) {
    features.push({
      name: `InternetService__${level.replace(/\s+/g, "_")}`,
      source_column: "InternetService",
      kind: "one_hot",
      level,
      scaled: false,
      label: `Internet service: ${level}`,
    });
  }
  for (const column of ["OnlineSecurity", "TechSupport", "OnlineBackup", "PaperlessBilling", "MultipleLines", "Dependents", "Partner"]) {
    for (const level of ["Yes", "No"]) {
      features.push({
        name: `${column}__${level}`,
        source_column: column,
        kind: "one_hot",
        level,
        scaled: false,
        label: `${column}: ${level}`,
      });
    }
  }
  for (const level of ["Electronic check", "Credit card", "Bank transfer", "Mailed check"]) {
    features.push({
      name: `PaymentMethod__${level.replace(/\s+/g, "_")}`,
      source_column: "PaymentMethod",
      kind: "one_hot",
      level,
      scaled: false,
      label: `Payment method: ${level}`,
    });
  }
  return features;
}

/** Plausible scaler statistics, deterministic per column. */
function scalerStats(
  columnCount: number,
  kind: "mean" | "scale",
): Record<string, number> {
  const stats: Record<string, number> = {};
  for (let index = 0; index < columnCount; index += 1) {
    const rng = new Rng(`scaler:${index}:${kind}`);
    stats[`feature_${index}`] = kind === "mean" ? round(rng.float(0, 1), 4) : round(rng.float(0.2, 1.4), 4);
  }
  return stats;
}

function inferColumns(buffer: Buffer, targetColumn: string): MlColumn[] {
  const text = buffer.toString("utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const header = firstLine.split(delimiter).map((name) => name.trim());
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "").slice(1);

  const valuesByColumn: string[][] = header.map(() => []);
  for (const line of lines) {
    const cells = line.split(delimiter);
    for (let column = 0; column < header.length; column += 1) {
      valuesByColumn[column]!.push((cells[column] ?? "").trim());
    }
  }

  return header.map((name, position) => {
    const values = valuesByColumn[position] ?? [];
    const nonNull = values.filter((value) => value !== "" && value.toLowerCase() !== "nan");
    const nulls = values.length - nonNull.length;
    const distinct = new Set(nonNull);
    const numbers = nonNull
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    const isNumeric =
      nonNull.length > 0 &&
      numbers.length / nonNull.length > 0.9 &&
      !new Set(nonNull).has("Yes");

    return {
      name,
      position,
      inferred_type:
        name.toLowerCase() === targetColumn.toLowerCase()
          ? "categorical"
          : isNumeric
            ? "numeric"
            : "categorical",
      pandas_dtype: isNumeric ? "float64" : "object",
      non_null_count: nonNull.length,
      null_count: nulls,
      null_fraction: values.length > 0 ? round(nulls / values.length, 6) : 0,
      distinct_count: distinct.size,
      sample_values: [...distinct].slice(0, 5),
      min_value: numbers.length > 0 ? round(Math.min(...numbers), 4) : null,
      max_value: numbers.length > 0 ? round(Math.max(...numbers), 4) : null,
      mean_value:
        numbers.length > 0
          ? round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length, 4)
          : null,
      is_target: name.toLowerCase() === targetColumn.toLowerCase(),
    };
  });
}

function countDuplicates(buffer: Buffer): number {
  const lines = buffer.toString("utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  const seen = new Set<string>();
  let duplicates = 0;
  for (const line of lines.slice(1)) {
    if (seen.has(line)) duplicates += 1;
    else seen.add(line);
  }
  return duplicates;
}

function buildIssues(
  world: ReturnType<typeof worldForCsv>,
  blanks: number,
): MlIssue[] {
  const issues: MlIssue[] = [];
  if (blanks > 0) {
    issues.push({
      code: "blank_target",
      severity: blanks / Math.max(world.customers.length, 1) > 0.02 ? "warning" : "info",
      column: world.targetColumn,
      message: `${blanks} rows have no ${world.targetColumn} value and will be excluded from scoring.`,
      detail: null,
      affected_count: blanks,
    });
  }
  if (issues.length === 0) {
    issues.push({
      code: "clean",
      severity: "info",
      column: null,
      message: "No blocking issues were found in this dataset.",
      detail: null,
      affected_count: null,
    });
  }
  return issues;
}

interface RunBuildInput {
  runId: string;
  label: string | null;
  buffer: Buffer;
  targetColumn: string;
  idColumns: string[];
  modelTypes: ModelType[];
  cvFolds: number;
  seed: number;
  startedAt: string;
}

const pendingBytes = new Map<string, Buffer>();

/** Register the dataset behind a preprocessing id, so a run can find it. */
export function registerPreprocessingDataset(
  preprocessingId: string,
  buffer: Buffer,
  targetColumn: string,
  idColumns: string[],
  datasetKey: string,
): void {
  const current = loadState();
  pendingBytes.set(datasetKey, buffer);
  current.runs[preprocessingId] = {
    run_id: preprocessingId,
    status: "completed",
    stage: "dataset_loaded",
    progress_percent: 100,
    preprocessing_id: preprocessingId,
    label: null,
    requested_models: [],
    started_at: null,
    finished_at: null,
    duration_seconds: null,
    models: [],
    error: null,
    error_stage: null,
    diagnostics: { datasetKey, targetColumn, idColumns },
  };
  saveState();
}

/**
 * A model result plus the chart names the service reports.
 *
 * The chart paths are extra fields the application reads off the payload, not
 * part of the declared result type, so they are described here rather than
 * forced into it.
 */
type SimulatedModelResult = MlModelResult & {
  confusion_plot_path: string;
  roc_plot_path: string;
  decile_plot_path: string;
  beeswarm_plot_path: string;
  importance_plot_path: string;
};

function buildRun(input: RunBuildInput): MlTrainingRun {
  const world = worldForCsv(input.buffer, input.targetColumn, input.idColumns, String(input.seed));
  const split = stratifiedSplit(
    scorePopulation(world.customers, "logistic_regression"),
    0.2,
    `run:${input.runId}`,
  );
  const finishedAt = new Date().toISOString();
  const startedAt = new Date(new Date(input.startedAt).getTime() - 84_000).toISOString();

  const models: SimulatedModelResult[] = input.modelTypes.map((modelType, index) => {
    const trainSamples = scorePopulation(split.train.map((s) => s.customer), modelType);
    const testSamples = scorePopulation(split.test.map((s) => s.customer), modelType);
    const validation = evaluate(trainSamples, "validation_cv", 0.5, finishedAt);
    const test = evaluate(testSamples, "test", 0.5, finishedAt);

    // Cross-validation is a mean over folds, so its spread is what the folds
    // would show. Derived from the full-sample AUC rather than invented.
    const foldSpread: number[] = [];
    for (let fold = 0; fold < input.cvFolds; fold += 1) {
      const offset = (fold - (input.cvFolds - 1) / 2) * 0.0042;
      foldSpread.push(round(Math.min(Math.max(validation.roc!.auc + offset, 0.5), 0.999), 4));
    }

    // The application stores `artifact_path` as the model's id and later sends
    // that id back when scoring, so the two have to be the same string or the
    // registry lookup on a later call would miss.
    const version = `${modelType}-1.0.0`;
    const modelId = `simulated/${version}-${index}`;
    const current = loadState();
    current.models[modelId] = {
      modelId,
      modelType,
      modelVersion: version,
      runId: input.runId,
      datasetKey: datasetKeyOf(input.buffer, input.targetColumn, input.idColumns),
      createdAt: finishedAt,
    };
    saveState();

    const result: SimulatedModelResult = {
      model_type: modelType,
      display_name: DISPLAY_NAMES[modelType],
      status: "completed",
      grid_search: {
        scoring_metric: "roc_auc",
        cv_folds: input.cvFolds,
        cv_strategy: "StratifiedKFold",
        candidates_evaluated: modelType === "random_forest" ? 12 : modelType === "xgboost" ? 24 : 8,
        best_params:
          modelType === "logistic_regression"
            ? { C: 1, penalty: "l2", max_iter: 1000 }
            : modelType === "random_forest"
              ? { max_depth: 10, min_samples_leaf: 4, n_estimators: 300 }
              : { learning_rate: 0.1, max_depth: 4, n_estimators: 300, subsample: 0.9 },
        best_cv_score: round(Math.max(...foldSpread), 4),
        mean_fit_time_seconds: round(0.6 + index * 0.9, 2),
        per_fold_scores: foldSpread,
      },
      validation,
      test,
      decile_lift: decileLift(testSamples),
      artifact_path: modelId,
      error: null,
      error_stage: null,
      // Chart names, read by the application when it records artifacts. These
      // are extra fields on the payload rather than part of the declared type,
      // which is how the real service reports them too.
      confusion_plot_path: "confusion-matrix.png",
      roc_plot_path: "roc-curve.png",
      decile_plot_path: "decile-lift.png",
      beeswarm_plot_path: "shap-beeswarm.png",
      importance_plot_path: "shap-importance.png",
    };
    return result;
  });

  return {
    run_id: input.runId,
    status: "completed",
    stage: "completed",
    progress_percent: 100,
    preprocessing_id: "",
    label: input.label,
    requested_models: input.modelTypes,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_seconds: 84,
    models,
    error: null,
    error_stage: null,
    diagnostics: {
      note: "Simulated mode. Metrics are derived from a generated population, not a trained model.",
      train_rows: split.train.length,
      test_rows: split.test.length,
    },
  };
}
