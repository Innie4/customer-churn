/**
 * Customers, predictions and SHAP explanations.
 *
 * A prediction always records the model version that produced it and the
 * thresholds that were in force, and an explanation always records the
 * prediction it explains. That chain is what makes a customer-level decision
 * reproducible months later.
 */

import "server-only";

import { getDatabase } from "../../../db/client";
import { AppError } from "../api";
import { AUDIT, recordAudit } from "../audit";
import { ml, type MlLocalExplanation } from "../ml-client";
import { CONTENT_TYPES } from "../storage";
import { requireActor, requireCapability } from "./access";
import { formatBytes, isUuid, readDatasetFile } from "./datasets";
import { getDataset } from "./datasets";
import {
  modelSourceFile,
  type ModelResultSummary,
} from "./models";
import { getRiskThresholds } from "./settings";

export type RiskCategory = "low" | "medium" | "high";

export interface CustomerListItem {
  id: string;
  externalId: string;
  displayName: string | null;
  datasetId: string;
  datasetName: string | null;
  churnProbability: number | null;
  riskCategory: RiskCategory | null;
  predictedAt: string | null;
  modelName: string | null;
  modelVersion: string | null;
  hasExplanation: boolean;
  observedChurn: number | null;
  openActions: number;
}

export interface CustomerDetail extends CustomerListItem {
  attributes: Record<string, unknown>;
  predictionId: string | null;
  modelId: string | null;
  mlModelId: string | null;
  riskThresholds: { high: number; medium: number } | null;
  predictionHistory: PredictionSummary[];
  strategies: SuggestedStrategy[];
  actions: RetentionActionSummary[];
}

export interface PredictionSummary {
  id: string;
  churnProbability: number;
  predictedLabel: number;
  riskCategory: RiskCategory;
  riskThresholds: { high: number; medium: number };
  modelVersion: string;
  modelName: string | null;
  modelType: string | null;
  isActiveModel: boolean;
  predictedAt: string;
  createdByName: string | null;
  hasExplanation: boolean;
}

export interface SuggestedStrategy {
  id: string;
  title: string;
  description: string;
  triggeringCondition: string;
  riskDriver: string;
  suggestedIntervention: string;
  priority: string;
  status: string;
  matchedFeature: string | null;
  matchedShapValue: number | null;
  hasOpenAction: boolean;
}

export interface RetentionActionSummary {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignedToName: string | null;
  dueDate: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  strategyTitle: string | null;
}

export interface CustomerListOptions {
  search?: string;
  risk?: RiskCategory | "all" | "unscored";
  datasetId?: string;
  sort?: "risk" | "name" | "recent" | "probability";
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const CUSTOMER_SELECT = `
  SELECT c.id, c.external_id, c.display_name, c.dataset_id, d.name AS dataset_name,
         c.attributes, c.churn_label_observed,
         p.id AS prediction_id, p.churn_probability, p.risk_category,
         p.predicted_at, p.risk_thresholds, p.model_version,
         m.display_name AS model_name, m.id AS model_id, m.is_active AS model_active,
         m.ml_model_id,
         (SELECT count(*) FROM prediction_explanations e
           WHERE e.prediction_id = p.id AND e.status = 'completed') AS has_explanation,
         (SELECT count(*) FROM customer_retention_actions a
           WHERE a.customer_id = c.id
             AND a.status NOT IN ('completed','cancelled')) AS open_actions
    FROM customers c
    LEFT JOIN datasets d ON d.id = c.dataset_id
    LEFT JOIN predictions p ON p.id = c.latest_prediction_id
    LEFT JOIN model_results m ON m.id = p.model_result_id
`;

interface CustomerRow {
  id: string;
  external_id: string;
  display_name: string | null;
  dataset_id: string;
  dataset_name: string | null;
  attributes: Record<string, unknown>;
  churn_label_observed: number | null;
  prediction_id: string | null;
  churn_probability: string | null;
  risk_category: RiskCategory | null;
  predicted_at: string | null;
  risk_thresholds: { high: number; medium: number } | null;
  model_version: string | null;
  model_name: string | null;
  model_id: string | null;
  model_active: boolean | null;
  ml_model_id: string | null;
  has_explanation: string;
  open_actions: string;
}

function toListItem(row: CustomerRow): CustomerListItem {
  return {
    id: row.id,
    externalId: row.external_id,
    displayName: row.display_name,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    churnProbability: row.churn_probability
      ? Number(row.churn_probability)
      : null,
    riskCategory: row.risk_category,
    predictedAt: row.predicted_at,
    modelName: row.model_name,
    modelVersion: row.model_version,
    hasExplanation: Number(row.has_explanation) > 0,
    observedChurn: row.churn_label_observed,
    openActions: Number(row.open_actions),
  };
}

export async function listCustomers(
  options: CustomerListOptions = {},
): Promise<Paged<CustomerListItem>> {
  await requireActor();
  const db = await getDatabase();

  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 200);
  const page = Math.max(options.page ?? 1, 1);
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (options.datasetId && isUuid(options.datasetId)) {
    params.push(options.datasetId);
    clauses.push(`c.dataset_id = $${params.length}`);
  }

  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim()}%`);
    const index = params.length;
    clauses.push(
      `(c.external_id ILIKE $${index} OR c.display_name ILIKE $${index})`,
    );
  }

  if (options.risk === "unscored") {
    clauses.push("c.latest_prediction_id IS NULL");
  } else if (options.risk && options.risk !== "all") {
    params.push(options.risk);
    clauses.push(`p.risk_category = $${params.length}`);
  }

  // Sorting is chosen from a fixed set, never interpolated from the request.
  const direction = options.direction === "asc" ? "ASC" : "DESC";
  const orderBy: Record<string, string> = {
    risk: `CASE p.risk_category WHEN 'high' THEN 3 WHEN 'medium' THEN 2
                                WHEN 'low' THEN 1 ELSE 0 END ${direction}, c.external_id ASC`,
    probability: `p.churn_probability ${direction} NULLS LAST, c.external_id ASC`,
    name: `c.external_id ${direction}`,
    recent: `p.predicted_at ${direction} NULLS LAST, c.external_id ASC`,
  };
  const order = orderBy[options.sort ?? "risk"] ?? orderBy.risk;

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const from = `FROM customers c
    LEFT JOIN datasets d ON d.id = c.dataset_id
    LEFT JOIN predictions p ON p.id = c.latest_prediction_id
    LEFT JOIN model_results m ON m.id = p.model_result_id`;

  const countResult = await db.query<{ count: string }>(
    `SELECT count(*) AS count ${from} ${where}`,
    params,
  );
  const total = Number(countResult.rows[0].count);

  params.push(pageSize, (page - 1) * pageSize);
  const rows = await db.query<CustomerRow>(
    `SELECT c.id, c.external_id, c.display_name, c.dataset_id,
            d.name AS dataset_name, c.attributes, c.churn_label_observed,
            p.id AS prediction_id, p.churn_probability, p.risk_category,
            p.predicted_at, p.risk_thresholds, p.model_version,
            m.display_name AS model_name, m.id AS model_id,
            m.is_active AS model_active, m.ml_model_id,
            (SELECT count(*) FROM prediction_explanations e
              WHERE e.prediction_id = p.id AND e.status = 'completed') AS has_explanation,
            (SELECT count(*) FROM customer_retention_actions a
              WHERE a.customer_id = c.id
                AND a.status NOT IN ('completed','cancelled')) AS open_actions
       ${from} ${where}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    items: rows.rows.map(toListItem),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getCustomer(
  customerId: string,
): Promise<CustomerDetail | null> {
  await requireActor();
  if (!isUuid(customerId)) return null;
  const db = await getDatabase();
  const result = await db.query<CustomerRow>(
    `${CUSTOMER_SELECT} WHERE c.id = $1`,
    [customerId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const history = await db.query<{
    id: string;
    churn_probability: string;
    predicted_label: number;
    risk_category: RiskCategory;
    risk_thresholds: { high: number; medium: number };
    model_version: string;
    model_name: string | null;
    model_type: string | null;
    is_active: boolean | null;
    predicted_at: string;
    created_by_name: string | null;
    has_explanation: string;
  }>(
    `SELECT p.id, p.churn_probability, p.predicted_label, p.risk_category,
            p.risk_thresholds, p.model_version, p.predicted_at,
            m.display_name AS model_name, m.model_type, m.is_active,
            u.full_name AS created_by_name,
            (SELECT count(*) FROM prediction_explanations e
              WHERE e.prediction_id = p.id AND e.status = 'completed') AS has_explanation
       FROM predictions p
       LEFT JOIN model_results m ON m.id = p.model_result_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.customer_id = $1
      ORDER BY p.predicted_at DESC`,
    [customerId],
  );

  const actions = await db.query<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    assigned_to_name: string | null;
    due_date: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    created_at: string;
    strategy_title: string | null;
  }>(
    `SELECT a.id, a.title, a.description, a.status, a.priority,
            u.full_name AS assigned_to_name, a.due_date, a.completed_at,
            a.cancelled_at, a.created_at, s.title AS strategy_title
       FROM customer_retention_actions a
       LEFT JOIN users u ON u.id = a.assigned_to
       LEFT JOIN retention_strategies s ON s.id = a.strategy_id
      WHERE a.customer_id = $1
      ORDER BY a.created_at DESC`,
    [customerId],
  );

  return {
    ...toListItem(row),
    attributes: row.attributes ?? {},
    predictionId: row.prediction_id,
    modelId: row.model_id,
    mlModelId: row.ml_model_id,
    riskThresholds: row.risk_thresholds,
    predictionHistory: history.rows.map((h) => ({
      id: h.id,
      churnProbability: Number(h.churn_probability),
      predictedLabel: h.predicted_label,
      riskCategory: h.risk_category,
      riskThresholds: h.risk_thresholds,
      modelVersion: h.model_version,
      modelName: h.model_name,
      modelType: h.model_type,
      isActiveModel: Boolean(h.is_active),
      predictedAt: h.predicted_at,
      createdByName: h.created_by_name,
      hasExplanation: Number(h.has_explanation) > 0,
    })),
    strategies: [],
    actions: actions.rows.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      status: a.status,
      priority: a.priority,
      assignedToName: a.assigned_to_name,
      dueDate: a.due_date,
      completedAt: a.completed_at,
      cancelledAt: a.cancelled_at,
      createdAt: a.created_at,
      strategyTitle: a.strategy_title,
    })),
  };
}

/**
 * Strategies relevant to a customer, ranked by how strongly the model
 * associated their driver with this customer's risk.
 *
 * Suggestions come from the approved strategy library matched against the
 * customer's own SHAP contributions, so what is offered is specific to that
 * customer rather than a generic list.
 */
export async function suggestStrategiesForCustomer(
  customerId: string,
): Promise<SuggestedStrategy[]> {
  await requireActor();
  if (!isUuid(customerId)) return [];
  const db = await getDatabase();

  const customer = await db.query<{ latest_prediction_id: string | null }>(
    "SELECT latest_prediction_id FROM customers WHERE id = $1",
    [customerId],
  );
  const predictionId = customer.rows[0]?.latest_prediction_id;
  if (!predictionId) return [];

  const explanation = await db.query<{
    contributions: { source_column: string; shap_value: number; direction: string }[];
  }>(
    `SELECT contributions FROM prediction_explanations
      WHERE prediction_id = $1 AND status = 'completed'`,
    [predictionId],
  );
  const contributions = explanation.rows[0]?.contributions ?? [];
  if (contributions.length === 0) return [];

  const existing = await db.query<{ strategy_id: string }>(
    `SELECT strategy_id FROM customer_retention_actions
      WHERE customer_id = $1 AND strategy_id IS NOT NULL
        AND status NOT IN ('completed','cancelled')`,
    [customerId],
  );
  const taken = new Set(existing.rows.map((r) => r.strategy_id));

  const strategies = await db.query<{
    id: string;
    title: string;
    description: string;
    triggering_condition: string;
    risk_driver: string;
    source_column: string | null;
    suggested_intervention: string;
    priority: string;
    status: string;
  }>(
    `SELECT id, title, description, triggering_condition, risk_driver,
            source_column, suggested_intervention, priority, status
       FROM retention_strategies
      WHERE status = 'approved'
      ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                      WHEN 'medium' THEN 2 ELSE 3 END,
        title`,
  );

  const bySource = new Map<string, { value: number; direction: string }>();
  for (const item of contributions) {
    const current = bySource.get(item.source_column);
    if (!current || Math.abs(item.shap_value) > Math.abs(current.value)) {
      bySource.set(item.source_column, {
        value: item.shap_value,
        direction: item.direction,
      });
    }
  }

  const matched: SuggestedStrategy[] = [];
  for (const strategy of strategies.rows) {
    const source = strategy.source_column;
    if (!source || !bySource.has(source)) continue;
    const contribution = bySource.get(source)!;
    // Only suggest a strategy when the model actually pushed risk up for this
    // customer. A strategy whose driver is pulling risk down is not relevant.
    if (contribution.value <= 0) continue;
    matched.push({
      id: strategy.id,
      title: strategy.title,
      description: strategy.description,
      triggeringCondition: strategy.triggering_condition,
      riskDriver: strategy.risk_driver,
      suggestedIntervention: strategy.suggested_intervention,
      priority: strategy.priority,
      status: strategy.status,
      matchedFeature: source,
      matchedShapValue: Number(contribution.value.toFixed(6)),
      hasOpenAction: taken.has(strategy.id),
    });
  }

  return matched.sort(
    (a, b) =>
      Math.abs(b.matchedShapValue ?? 0) - Math.abs(a.matchedShapValue ?? 0),
  );
}

export interface GeneratePredictionsInput {
  modelId: string;
  /** Which customers to score. Defaults to every customer in the model's dataset. */
  customerIds?: string[];
  highThreshold?: number;
  mediumThreshold?: number;
}

export interface GeneratedPrediction {
  id: string;
  customerId: string;
  externalId: string;
  churnProbability: number;
  predictedLabel: number;
  riskCategory: RiskCategory;
}

export interface GeneratePredictionsResult {
  modelId: string;
  modelName: string;
  modelVersion: string;
  scored: number;
  created: number;
  updated: number;
  riskCounts: Record<RiskCategory, number>;
  thresholds: { high: number; medium: number };
  warnings: string[];
  /** The scored customers, so a caller can act without a second query. */
  predictions: GeneratedPrediction[];
}

/**
 * Score customers with an active model and store the results.
 *
 * Rows are matched back to customers by the identifier column recorded at
 * preprocessing time. A row that cannot be matched is counted and reported
 * rather than silently dropped.
 */
export async function generatePredictions(
  input: GeneratePredictionsInput,
): Promise<GeneratePredictionsResult> {
  const actor = await requireCapability("manageModels");
  if (!isUuid(input.modelId)) throw AppError.notFound("That model does not exist.");

  const { getModel } = await import("./models");
  const model = await getModel(input.modelId);
  if (!model) throw AppError.notFound("That model does not exist.");
  if (model.status !== "completed") {
    throw AppError.unprocessable(
      "That model did not finish training, so it cannot score customers.",
      { nextAction: "Train a new model or wait for the current run to finish." },
    );
  }
  if (!model.mlModelId) {
    throw AppError.internal(
      "That model has no artifact reference, so it cannot be scored with.",
    );
  }

  const dataset = await getDataset(model.datasetId);
  if (!dataset) throw AppError.notFound("The dataset for that model is missing.");

  const thresholds = await getRiskThresholds();
  const high = input.highThreshold ?? thresholds.high;
  const medium = input.mediumThreshold ?? thresholds.medium;

  const buffer = await readDatasetFile(dataset.storagePath);
  const db = await getDatabase();

  const idColumns = await db.query<{ id_columns: string[] }>(
    "SELECT id_columns FROM (SELECT params->'id_columns' AS id_columns FROM preprocessing_runs WHERE id = $1) s",
    [model.preprocessingRunId],
  );
  const identifierColumns: string[] = idColumns.rows[0]?.id_columns ?? [];

  const targetColumn = await db.query<{ target_column: string }>(
    "SELECT params->>'target_column' AS target_column FROM preprocessing_runs WHERE id = $1",
    [model.preprocessingRunId],
  );
  const target = targetColumn.rows[0]?.target_column ?? dataset.targetColumn;

  let response;
  try {
    response = await ml.predict(
      model.mlModelId,
      { buffer, filename: dataset.originalFilename, contentType: CONTENT_TYPES.csv },
      { high, medium, idColumns: identifierColumns },
    );
  } catch (error) {
    await recordAudit({
      action: AUDIT.predictionFailed,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "model",
      resourceId: input.modelId,
      outcome: "failure",
      metadata: {
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      },
    });
    throw error;
  }

  const wanted = input.customerIds
    ? new Set(input.customerIds.filter(isUuid))
    : null;

  const customers = await db.query<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM customers WHERE dataset_id = $1`,
    [model.datasetId],
  );
  const byExternalId = new Map(
    customers.rows.map((row) => [row.external_id, row.id]),
  );

  let created = 0;
  let updated = 0;
  let unmatched = 0;
  const riskCounts: Record<RiskCategory, number> = { low: 0, medium: 0, high: 0 };
  // The scored customers, so a caller can act on the result without a second
  // query. Identifiers and risk bands only; the full rows are one request away.
  const scoredCustomers: GeneratedPrediction[] = [];

  await db.transaction(async (tx) => {
    for (const prediction of response.predictions) {
      const externalId = prediction.customer_id;
      if (!externalId) {
        unmatched += 1;
        continue;
      }
      const customerId = byExternalId.get(externalId);
      if (!customerId) {
        unmatched += 1;
        continue;
      }
      if (wanted && !wanted.has(customerId)) continue;

      const outcome = await tx.query<{ inserted: boolean; id: string }>(
        `INSERT INTO predictions
           (customer_id, model_result_id, model_version, ml_model_id,
            churn_probability, predicted_label, risk_category, risk_thresholds,
            source_row_index, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
         ON CONFLICT (customer_id, model_result_id) DO UPDATE
           SET churn_probability = EXCLUDED.churn_probability,
               predicted_label = EXCLUDED.predicted_label,
               risk_category = EXCLUDED.risk_category,
               risk_thresholds = EXCLUDED.risk_thresholds,
               predicted_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          customerId,
          input.modelId,
          response.model_version,
          response.model_id,
          prediction.churn_probability,
          prediction.predicted_label,
          prediction.risk_category,
          JSON.stringify({ high, medium }),
          prediction.row_index,
          actor.id,
        ],
      );
      if (outcome.rows[0]?.inserted) created += 1;
      else updated += 1;
      riskCounts[prediction.risk_category] += 1;
      scoredCustomers.push({
        id: outcome.rows[0].id,
        customerId,
        externalId,
        churnProbability: prediction.churn_probability,
        predictedLabel: prediction.predicted_label,
        riskCategory: prediction.risk_category,
      });
    }
  });

  const warnings = [...response.warnings];
  if (unmatched > 0) {
    warnings.push(
      `${unmatched} row${unmatched === 1 ? "" : "s"} could not be matched to a ` +
        "loaded customer and were not stored. This usually means the identifier " +
        "column changed between preprocessing and scoring.",
    );
  }
  if (!identifierColumns.length) {
    warnings.push(
      "No identifier column was recorded at preprocessing time, so predictions " +
        "were matched by row order. Re-run preprocessing with an identifier " +
        "column for reliable matching.",
    );
  }
  await recordAudit({
    action: AUDIT.predictionsGenerated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "model",
    resourceId: input.modelId,
    metadata: {
      created,
      updated,
      unmatched,
      riskCounts,
      thresholds: { high, medium },
      targetColumn: target,
    },
  });

  return {
    modelId: input.modelId,
    modelName: model.displayName,
    modelVersion: response.model_version,
    scored: created + updated,
    created,
    updated,
    riskCounts,
    thresholds: { high, medium },
    warnings,
    predictions: scoredCustomers,
  };
}

export interface ExplanationDetail {
  id: string;
  predictionId: string;
  modelId: string;
  status: string;
  explainer: string | null;
  isExact: boolean | null;
  baseValue: number | null;
  summary: string | null;
  contributions: {
    feature: string;
    label: string;
    source_column: string;
    value: string;
    shap_value: number;
    direction: "increases_risk" | "reduces_risk";
    kind: string;
  }[];
  topIncreasing: Explanation["contributions"];
  topReducing: Explanation["contributions"];
  waterfallPlotPath: string | null;
  additivityWarning: boolean;
  /**
   * The scale the SHAP values are in: `log_odds` for a generalised linear
   * model, `probability` for a tree ensemble.
   *
   * Derived from the explainer that was recorded, so it is derived rather than
   * asserted: a value in one scale read as the other is wrong by a wide margin,
   * and nothing in the numbers themselves reveals which they are.
   */
  units: "log_odds" | "probability";
  error: string | null;
  generatedAt: string | null;
  disclaimer: string;
}

export interface Explanation {
  id: string;
  predictionId: string;
  modelId: string;
  status: string;
  /** Whether the contributions were checked and rebuild the prediction. */
  isExact: boolean | null;
  /** Which explainer produced the values, for example "Linear SHAP". */
  explainer: string | null;
  waterfallPlotPath: string | null;
  baseValue: number | null;
  summary: string | null;
  contributions: ExplanationDetail["contributions"];
  topIncreasing: ExplanationDetail["contributions"];
  topReducing: ExplanationDetail["contributions"];
  additivityWarning: boolean;
  units: "log_odds" | "probability";
  error: string | null;
  generatedAt: string | null;
  disclaimer: string;
}

const DISCLAIMER =
  "SHAP values describe how the model reached this prediction. They show " +
  "association and contribution, not causation.";

export async function getExplanationForPrediction(
  predictionId: string,
): Promise<Explanation | null> {
  await requireActor();
  if (!isUuid(predictionId)) return null;
  const db = await getDatabase();
  const result = await db.query<{
    id: string;
    prediction_id: string;
    model_result_id: string;
    status: string;
    is_exact: boolean | null;
    waterfall_plot_path: string | null;
    base_value: string | null;
    summary: string | null;
    contributions: ExplanationDetail["contributions"];
    top_increasing: ExplanationDetail["contributions"];
    top_reducing: ExplanationDetail["contributions"];
    explainer: string | null;
    additivity_warning: boolean;
    error: string | null;
    generated_at: string | null;
  }>(
    `SELECT id, prediction_id, model_result_id, status, is_exact,
            waterfall_plot_path, base_value, summary,
            contributions, top_increasing, top_reducing, explainer,
            additivity_warning, error, generated_at
       FROM prediction_explanations WHERE prediction_id = $1`,
    [predictionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    predictionId: row.prediction_id,
    modelId: row.model_result_id,
    status: row.status,
    isExact: row.is_exact,
    explainer: row.explainer,
    waterfallPlotPath: row.waterfall_plot_path,
    baseValue: row.base_value ? Number(row.base_value) : null,
    summary: row.summary,
    contributions: row.contributions ?? [],
    topIncreasing: row.top_increasing ?? [],
    topReducing: row.top_reducing ?? [],
    additivityWarning: row.additivity_warning,
    units: unitsForExplainer(row.explainer),
    error: row.error,
    generatedAt: row.generated_at,
    disclaimer: DISCLAIMER,
  };
}

/**
 * Which scale a stored explanation's values are in.
 *
 * Derived from the explainer that was recorded when it was computed, so the two
 * cannot drift apart. A contribution in log-odds read as a probability is wrong
 * by a wide margin, so this is stated rather than left to be inferred.
 */
function unitsForExplainer(
  explainer: string | null,
): "log_odds" | "probability" {
  return explainer && explainer.includes("log-odds") ? "log_odds" : "probability";
}

/**
 * Generate the SHAP explanation for one customer.
 *
 * A failure here must not lose the prediction. The explanation row is written
 * with its error, and the customer page still shows the risk.
 */
export async function explainCustomer(
  customerId: string,
  options: { topN?: number } = {},
): Promise<Explanation> {
  const actor = await requireCapability("manageModels");
  if (!isUuid(customerId)) throw AppError.notFound("That customer does not exist.");

  const db = await getDatabase();
  const customer = await db.query<{
    latest_prediction_id: string | null;
    external_id: string;
  }>("SELECT latest_prediction_id, external_id FROM customers WHERE id = $1", [
    customerId,
  ]);
  const row = customer.rows[0];
  if (!row) throw AppError.notFound("That customer does not exist.");
  if (!row.latest_prediction_id) {
    throw AppError.unprocessable(
      "This customer has not been scored yet, so there is nothing to explain.",
      { nextAction: "Generate predictions first, then explain this customer." },
    );
  }

  const prediction = await db.query<{
    id: string;
    model_result_id: string;
    ml_model_id: string;
    source_row_index: number | null;
    churn_probability: string;
  }>(
    `SELECT p.id, p.model_result_id, p.ml_model_id, p.source_row_index,
            p.churn_probability
       FROM predictions p WHERE p.id = $1`,
    [row.latest_prediction_id],
  );
  const record = prediction.rows[0];
  if (!record) throw AppError.notFound("That prediction no longer exists.");

  const source = await modelSourceFile(record.model_result_id);
  const externalId = row.external_id;

  // The row index the service reported when it scored this customer, so the
  // explanation refers to the same row rather than a guess.
  const rowIndex = record.source_row_index ?? 0;

  let serviceExplanation: MlLocalExplanation;
  try {
    serviceExplanation = await ml.localExplanation(
      record.ml_model_id,
      {
        buffer: source.buffer,
        filename: source.filename,
        contentType: CONTENT_TYPES.csv,
      },
      { rowIndex, customerId: externalId, topN: options.topN ?? 5 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The explanation could not be generated";
    const stage =
      typeof error === "object" && error !== null && "stage" in error
        ? String((error as { stage: unknown }).stage)
        : "explanation";

    await db.query(
      `INSERT INTO prediction_explanations
         (prediction_id, model_result_id, status, error, error_stage)
       VALUES ($1, $2, 'failed', $3, $4)
       ON CONFLICT (prediction_id) DO UPDATE
         SET status = 'failed', error = EXCLUDED.error,
             error_stage = EXCLUDED.error_stage, contributions = '[]'::jsonb,
             top_increasing = '[]'::jsonb, top_reducing = '[]'::jsonb`,
      [record.id, record.model_result_id, message.slice(0, 1000), stage],
    );
    await recordAudit({
      action: AUDIT.explanationFailed,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "prediction",
      resourceId: record.id,
      outcome: "failure",
      metadata: { stage, customerId },
    });
    throw error;
  }

  // The check that matters: do the contributions rebuild the prediction the
  // model actually made? If not, the interface says so, and the row is not
  // recorded as exact — a row that claims exactness while carrying an additivity
  // warning would be stating two contradictory things at once.
  const baseValue = serviceExplanation.base_value;
  const total = serviceExplanation.all_contributions.reduce(
    (sum, item) => sum + item.shap_value,
    0,
  );
  const rebuilt =
    serviceExplanation.model_type === "logistic_regression"
      ? 1 / (1 + Math.exp(-(baseValue + total)))
      : baseValue + total;
  const predicted = Number(record.churn_probability);
  const additivityWarning = Math.abs(rebuilt - predicted) > 0.02;
  const isExact = !additivityWarning;

  // The scale the contributions are in. A SHAP value cannot be read without
  // knowing this, and a log-odds contribution read as a probability is wrong by
  // a wide margin, so it is recorded as data and read back from the explainer
  // rather than left to be inferred from a sentence in the summary.
  const isLinear = serviceExplanation.model_type === "logistic_regression";

  await db.query(
    `INSERT INTO prediction_explanations
       (prediction_id, model_result_id, status, explainer, is_exact, base_value,
        summary, contributions, top_increasing, top_reducing,
        waterfall_plot_path, additivity_warning, generated_at)
     VALUES ($1,$2,'completed',$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,now())
     ON CONFLICT (prediction_id) DO UPDATE
       SET status = 'completed', explainer = EXCLUDED.explainer,
           is_exact = EXCLUDED.is_exact, base_value = EXCLUDED.base_value,
           summary = EXCLUDED.summary, contributions = EXCLUDED.contributions,
           top_increasing = EXCLUDED.top_increasing,
           top_reducing = EXCLUDED.top_reducing,
           waterfall_plot_path = EXCLUDED.waterfall_plot_path,
           additivity_warning = EXCLUDED.additivity_warning,
           error = NULL, error_stage = NULL, generated_at = now()
     RETURNING id`,
    [
      record.id,
      record.model_result_id,
      isLinear ? "Linear SHAP (log-odds output)" : "TreeSHAP (probability output)",
      isExact,
      baseValue,
      serviceExplanation.summary,
      JSON.stringify(serviceExplanation.all_contributions),
      JSON.stringify(serviceExplanation.top_increasing_risk),
      JSON.stringify(serviceExplanation.top_reducing_risk),
      serviceExplanation.waterfall_plot_path
        ? serviceExplanation.waterfall_plot_path
        : null,
      additivityWarning,
    ],
  );

  await recordAudit({
    action: AUDIT.explanationGenerated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "prediction",
    resourceId: record.id,
    metadata: {
      customerId,
      contributions: serviceExplanation.all_contributions.length,
      additivityWarning,
    },
  });

  const stored = await getExplanationForPrediction(record.id);
  if (!stored) throw AppError.internal("The explanation could not be read back.");
  return stored;
}

export interface GlobalExplanationResult {
  modelId: string;
  modelName: string;
  modelVersion: string;
  sampleSize: number;
  /** The service's caveat about comparing these values across datasets. */
  note: string | null;
  features: {
    rank: number;
    label: string;
    sourceColumn: string;
    meanAbsShap: number;
    direction: string;
    kind: string;
  }[];
  beeswarmPlotPath: string | null;
  importancePlotPath: string | null;
  disclaimer: string;
}

export async function generateGlobalExplanation(
  modelId: string,
  options: { sampleSize?: number } = {},
): Promise<GlobalExplanationResult> {
  const actor = await requireCapability("manageModels");
  const db = await getDatabase();
  if (!isUuid(modelId)) throw AppError.notFound("That model does not exist.");
  const { getModel } = await import("./models");
  const model = await getModel(modelId);
  if (!model) throw AppError.notFound("That model does not exist.");
  if (!model.mlModelId) {
    throw AppError.internal("That model has no artifact to explain.");
  }

  const source = await modelSourceFile(modelId);
  const explanation = await ml.globalExplanation(
    model.mlModelId,
    { buffer: source.buffer, filename: source.filename, contentType: CONTENT_TYPES.csv },
    { sampleSize: options.sampleSize },
  );

  await recordAudit({
    action: AUDIT.explanationGenerated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "model",
    resourceId: modelId,
    metadata: { scope: "global", sampleSize: explanation.sample_size },
  });

  const result: GlobalExplanationResult = {
    modelId,
    modelName: model.displayName,
    modelVersion: model.version ?? "",
    sampleSize: explanation.sample_size,
    note: explanation.class_balance_note,
    features: explanation.features.map((feature) => ({
      rank: feature.rank,
      label: feature.label,
      sourceColumn: feature.source_column,
      meanAbsShap: feature.mean_abs_shap,
      direction: feature.direction,
      kind: feature.kind,
    })),
    beeswarmPlotPath: explanation.beeswarm_plot_path,
    importancePlotPath: explanation.importance_plot_path,
    disclaimer: explanation.disclaimer,
  };

  // Stored so the model page can show what was measured without recomputing it
  // on every view, and so the figures cannot silently change underneath a
  // reader who is comparing two models.
  //
  // The version is the same string `model_results.version` carries. It is
  // checked rather than defaulted, because an explanation recorded against no
  // version could not be traced back to the model it describes.
  const modelVersion = model.version?.trim();
  if (!modelVersion) {
    throw AppError.unprocessable(
      "That model has no version number, so its explanation cannot be recorded.",
      { nextAction: "Re-run training for this model, then generate the explanation." },
    );
  }

  await db.query(
    `INSERT INTO model_global_explanations
       (model_result_id, model_version, sample_size, features,
        class_balance_note, disclaimer, generated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (model_result_id, model_version) DO UPDATE
       SET sample_size = EXCLUDED.sample_size,
           features = EXCLUDED.features,
           class_balance_note = EXCLUDED.class_balance_note,
           disclaimer = EXCLUDED.disclaimer,
           generated_by = EXCLUDED.generated_by`,
    [
      modelId,
      modelVersion,
      explanation.sample_size,
      JSON.stringify(result.features),
      explanation.class_balance_note ?? null,
      explanation.disclaimer,
      actor.id,
    ],
  );

  return result;
}

/**
 * The stored global explanation for a model, or null.
 *
 * Reads what was measured rather than recomputing it. Returns null when none
 * has been generated, which the interface states rather than showing nothing.
 */
export async function getGlobalExplanation(
  modelId: string,
): Promise<GlobalExplanationResult | null> {
  await requireActor();
  if (!isUuid(modelId)) return null;
  const db = await getDatabase();

  const row = await db.query<{
    model_result_id: string;
    model_version: string;
    sample_size: number;
    features: GlobalExplanationResult["features"];
    class_balance_note: string | null;
    disclaimer: string;
  }>(
    `SELECT g.model_result_id, g.model_version, g.sample_size, g.features,
            g.class_balance_note, g.disclaimer
       FROM model_global_explanations g
       JOIN model_results m ON m.id = g.model_result_id
      WHERE g.model_result_id = $1
      ORDER BY g.model_version DESC, g.created_at DESC
      LIMIT 1`,
    [modelId],
  );
  const found = row.rows[0];
  if (!found) return null;

  const { getModel } = await import("./models");
  const model = await getModel(modelId);

  return {
    modelId: found.model_result_id,
    modelName: model?.displayName ?? "",
    modelVersion: String(found.model_version),
    sampleSize: found.sample_size,
    note: found.class_balance_note,
    features: found.features,
    beeswarmPlotPath: null,
    importancePlotPath: null,
    disclaimer: found.disclaimer,
  };
}

export interface PredictionListItem extends PredictionSummary {
  customerId: string;
  customerExternalId: string;
  customerName: string | null;
  datasetName: string | null;
}

export async function listPredictions(options: {
  risk?: RiskCategory | "all";
  modelId?: string;
  page?: number;
  pageSize?: number;
  search?: string;
}): Promise<Paged<PredictionListItem>> {
  await requireActor();
  const db = await getDatabase();
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 200);
  const page = Math.max(options.page ?? 1, 1);
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (options.risk && options.risk !== "all") {
    params.push(options.risk);
    clauses.push(`p.risk_category = $${params.length}`);
  }
  if (options.modelId && isUuid(options.modelId)) {
    params.push(options.modelId);
    clauses.push(`p.model_result_id = $${params.length}`);
  }
  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim()}%`);
    clauses.push(`c.external_id ILIKE $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const from = `FROM predictions p
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN model_results m ON m.id = p.model_result_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN datasets d ON d.id = c.dataset_id`;

  const count = await db.query<{ count: string }>(
    `SELECT count(*) AS count ${from} ${where}`,
    params,
  );
  const total = Number(count.rows[0].count);

  params.push(pageSize, (page - 1) * pageSize);
  const rows = await db.query<{
    id: string;
    churn_probability: string;
    predicted_label: number;
    risk_category: RiskCategory;
    risk_thresholds: { high: number; medium: number };
    model_version: string;
    model_name: string | null;
    model_type: string | null;
    is_active: boolean | null;
    predicted_at: string;
    created_by_name: string | null;
    has_explanation: string;
    customer_id: string;
    customer_external_id: string;
    customer_name: string | null;
    dataset_name: string | null;
  }>(
    `SELECT p.id, p.churn_probability, p.predicted_label, p.risk_category,
            p.risk_thresholds, p.model_version, p.predicted_at,
            m.display_name AS model_name, m.model_type, m.is_active,
            u.full_name AS created_by_name,
            (SELECT count(*) FROM prediction_explanations e
              WHERE e.prediction_id = p.id AND e.status = 'completed') AS has_explanation,
            c.id AS customer_id, c.external_id AS customer_external_id,
            c.display_name AS customer_name, d.name AS dataset_name
       ${from} ${where}
      ORDER BY p.predicted_at DESC, p.churn_probability DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    items: rows.rows.map((row) => ({
      id: row.id,
      churnProbability: Number(row.churn_probability),
      predictedLabel: row.predicted_label,
      riskCategory: row.risk_category,
      riskThresholds: row.risk_thresholds,
      modelVersion: row.model_version,
      modelName: row.model_name,
      modelType: row.model_type,
      isActiveModel: Boolean(row.is_active),
      predictedAt: row.predicted_at,
      createdByName: row.created_by_name,
      hasExplanation: Number(row.has_explanation) > 0,
      customerId: row.customer_id,
      customerExternalId: row.customer_external_id,
      customerName: row.customer_name,
      datasetName: row.dataset_name,
    })),
  };
}

export async function getPrediction(
  predictionId: string,
): Promise<PredictionListItem | null> {
  await requireActor();
  if (!isUuid(predictionId)) return null;
  const db = await getDatabase();
  const rows = await db.query<{
    id: string;
    churn_probability: string;
    predicted_label: number;
    risk_category: RiskCategory;
    risk_thresholds: { high: number; medium: number };
    model_version: string;
    model_name: string | null;
    model_type: string | null;
    is_active: boolean | null;
    predicted_at: string;
    created_by_name: string | null;
    has_explanation: string;
    customer_id: string;
    customer_external_id: string;
    customer_name: string | null;
    dataset_name: string | null;
  }>(
    `SELECT p.id, p.churn_probability, p.predicted_label, p.risk_category,
            p.risk_thresholds, p.model_version, p.predicted_at,
            m.display_name AS model_name, m.model_type, m.is_active,
            u.full_name AS created_by_name,
            (SELECT count(*) FROM prediction_explanations e
              WHERE e.prediction_id = p.id AND e.status = 'completed') AS has_explanation,
            c.id AS customer_id, c.external_id AS customer_external_id,
            c.display_name AS customer_name, d.name AS dataset_name
       FROM predictions p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN model_results m ON m.id = p.model_result_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN datasets d ON d.id = c.dataset_id
      WHERE p.id = $1`,
    [predictionId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    churnProbability: Number(row.churn_probability),
    predictedLabel: row.predicted_label,
    riskCategory: row.risk_category,
    riskThresholds: row.risk_thresholds,
    modelVersion: row.model_version,
    modelName: row.model_name,
    modelType: row.model_type,
    isActiveModel: Boolean(row.is_active),
    predictedAt: row.predicted_at,
    createdByName: row.created_by_name,
    hasExplanation: Number(row.has_explanation) > 0,
    customerId: row.customer_id,
    customerExternalId: row.customer_external_id,
    customerName: row.customer_name,
    datasetName: row.dataset_name,
  };
}

export type { ModelResultSummary };
export { formatBytes };
