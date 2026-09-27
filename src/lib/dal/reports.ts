/**
 * Report generation and the audit trail reader.
 *
 * A report is built from stored data only. Every figure in it is read from the
 * database, so a report cannot contain a number the system did not measure. The
 * report row records what it was built from, so it can be traced later.
 */

import "server-only";

import { getDatabase } from "../../../db/client";
import { AppError } from "../api";
import { AUDIT, recordAudit } from "../audit";
import { mlServiceReachable } from "../ml-client";
import {
  CONTENT_TYPES,
  extensionFor,
  generatedName,
  storage,
} from "../storage";
import {
  renderCsv,
  renderPdf,
  formatNumber,
  percent,
  type ReportDocument,
  type ReportFormat,
  type ReportSection,
} from "../report-render";
import { requireActor, requireCapability } from "./access";
import { isUuid } from "./datasets";
import { getModel, listModels } from "./models";
import { getRetentionSummary } from "./retention";

export type ReportKind =
  | "model_performance"
  | "prediction_summary"
  | "retention_summary"
  | "dataset_summary"
  | "shap_global"
  | "audit_trail";

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  model_performance: "Model performance",
  prediction_summary: "Prediction summary",
  retention_summary: "Retention summary",
  dataset_summary: "Dataset summary",
  shap_global: "Global feature importance",
  audit_trail: "Audit trail",
};

export interface ReportSummary {
  id: string;
  kind: ReportKind;
  title: string;
  format: ReportFormat;
  status: "pending" | "generating" | "completed" | "failed";
  sizeBytes: number | null;
  contentType: string | null;
  parameters: Record<string, unknown>;
  datasetId: string | null;
  datasetName: string | null;
  modelResultId: string | null;
  modelName: string | null;
  summary: Record<string, unknown>;
  error: string | null;
  generatedByName: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface ReportRow {
  id: string;
  kind: ReportKind;
  title: string;
  format: ReportFormat;
  status: ReportSummary["status"];
  size_bytes: string | null;
  content_type: string | null;
  parameters: Record<string, unknown>;
  dataset_id: string | null;
  dataset_name: string | null;
  model_result_id: string | null;
  model_name: string | null;
  summary: Record<string, unknown>;
  error: string | null;
  generated_by_name: string | null;
  created_at: string;
  completed_at: string | null;
  storage_path: string | null;
}

const REPORT_SELECT = `
  SELECT r.*, d.name AS dataset_name, m.display_name AS model_name,
         u.full_name AS generated_by_name
    FROM reports r
    LEFT JOIN datasets d ON d.id = r.dataset_id
    LEFT JOIN model_results m ON m.id = r.model_result_id
    LEFT JOIN users u ON u.id = r.generated_by
`;

function toSummary(row: ReportRow): ReportSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    format: row.format,
    status: row.status,
    sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
    contentType: row.content_type,
    parameters: row.parameters ?? {},
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    modelResultId: row.model_result_id,
    modelName: row.model_name,
    summary: row.summary ?? {},
    error: row.error,
    generatedByName: row.generated_by_name,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function listReports(limit = 50): Promise<ReportSummary[]> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<ReportRow>(
    `${REPORT_SELECT} ORDER BY r.created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toSummary);
}

export async function getReport(reportId: string): Promise<ReportSummary | null> {
  await requireActor();
  if (!isUuid(reportId)) return null;
  const db = await getDatabase();
  const result = await db.query<ReportRow>(`${REPORT_SELECT} WHERE r.id = $1`, [
    reportId,
  ]);
  return result.rows[0] ? toSummary(result.rows[0]) : null;
}

export interface GenerateReportInput {
  kind: ReportKind;
  format: ReportFormat;
  title?: string;
  datasetId?: string;
  modelResultId?: string;
  /** Scope choices, for example how many top-risk customers to list. */
  limit?: number;
}

/**
 * Generate a report and store it.
 *
 * A failure is recorded on the report row and re-raised, so the reports list
 * shows a failed attempt with its reason rather than nothing at all.
 */
export async function generateReport(
  input: GenerateReportInput,
): Promise<ReportSummary> {
  const actor = await requireCapability("manageModels");
  const limit = Math.min(Math.max(input.limit ?? 25, 5), 500);

  const db = await getDatabase();
  const title =
    input.title?.trim() ||
    `${REPORT_KIND_LABELS[input.kind]} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  const created = await db.query<{ id: string }>(
    `INSERT INTO reports
       (kind, title, format, status, parameters, dataset_id, model_result_id, generated_by)
     VALUES ($1,$2,$3,'generating',$4::jsonb,$5,$6,$7) RETURNING id`,
    [
      input.kind,
      title,
      input.format,
      JSON.stringify({ limit }),
      input.datasetId ?? null,
      input.modelResultId ?? null,
      actor.id,
    ],
  );
  const reportId = created.rows[0].id;

  try {
    const built = await buildReportDocument(input, limit);
    const bytes =
      input.format === "pdf"
        ? await renderPdf(built.document)
        : Buffer.from(renderCsv(built.document), "utf8");

    const extension = input.format === "pdf" ? ".pdf" : ".csv";
    const stored = await storage().put(
      "reports",
      generatedName("report", extension),
      bytes,
      CONTENT_TYPES[input.format],
    );

    await db.query(
      `UPDATE reports
          SET status = 'completed', storage_path = $2, size_bytes = $3,
              content_type = $4, summary = $5::jsonb, completed_at = now()
        WHERE id = $1`,
      [
        reportId,
        stored.relativePath,
        stored.sizeBytes,
        CONTENT_TYPES[input.format],
        JSON.stringify(built.summary),
      ],
    );

    await recordAudit({
      action: AUDIT.reportGenerated,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "report",
      resourceId: reportId,
      metadata: {
        kind: input.kind,
        format: input.format,
        sizeBytes: stored.sizeBytes,
        modelResultId: input.modelResultId ?? null,
      },
    });

    const report = await getReport(reportId);
    if (!report) throw AppError.internal("The report could not be read back.");
    return report;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Report generation failed";
    await db.query(
      `UPDATE reports
          SET status = 'failed', error = $2, error_stage = 'generation',
              completed_at = now()
        WHERE id = $1`,
      [reportId, message.slice(0, 1000)],
    );
    await recordAudit({
      action: AUDIT.reportFailed,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "report",
      resourceId: reportId,
      outcome: "failure",
      metadata: { kind: input.kind, format: input.format, error: message.slice(0, 300) },
    });
    throw error;
  }
}

interface BuiltReport {
  document: ReportDocument;
  summary: Record<string, unknown>;
}

async function buildReportDocument(
  input: GenerateReportInput,
  limit: number,
): Promise<BuiltReport> {
  switch (input.kind) {
    case "model_performance":
      return buildModelPerformanceReport(input, limit);
    case "prediction_summary":
      return buildPredictionSummaryReport(input, limit);
    case "retention_summary":
      return buildRetentionSummaryReport(input, limit);
    case "dataset_summary":
      return buildDatasetSummaryReport(input, limit);
    case "shap_global":
      return buildShapReport(input, limit);
    case "audit_trail":
      return buildAuditReport(input, limit);
    default:
      throw AppError.badRequest("That report type is not supported.");
  }
}

async function buildModelPerformanceReport(
  input: GenerateReportInput,
  limit: number,
): Promise<BuiltReport> {
  if (input.modelResultId) {
    const model = await getModel(input.modelResultId);
    if (!model) throw AppError.notFound("That model does not exist.");
    return singleModelReport(model, limit);
  }

  const models = (await listModels()).filter((m) => m.status === "completed");
  if (models.length === 0) {
    throw AppError.unprocessable(
      "No trained model is available to report on yet.",
      { nextAction: "Train a model first, then generate the report." },
    );
  }

  const meta = models.find((m) => m.isActive);
  return {
    document: {
      title: "Model performance comparison",
      subtitle:
        "Measured on each model's held-out test split. Validation and test figures are reported separately and never blended.",
      meta: [
        { label: "Models compared", value: String(models.length) },
        {
          label: "Active model",
          value: meta
            ? `${meta.displayName}${meta.version ? ` (${meta.version})` : ""}`
            : "None activated",
        },
        { label: "Generated", value: new Date().toISOString() },
      ],
      sections: [
        {
          heading: "Test set metrics",
          intro:
            "Accuracy alone is a poor guide for churn work, because a model can " +
            "score well by favouring the majority class. Recall matters most " +
            "here: a missed churner is a customer the retention team never got " +
            "the chance to save.",
          table: {
            columns: [
              "Model",
              "Accuracy",
              "Precision",
              "Recall",
              "F1",
              "AUC-ROC",
              "Active",
            ],
            align: [
              "left",
              "right",
              "right",
              "right",
              "right",
              "right",
              "center",
            ],
            rows: models.map((model) => [
              model.displayName,
              percent(model.testMetrics?.accuracy),
              percent(model.testMetrics?.precision),
              percent(model.testMetrics?.recall),
              formatNumber(model.testMetrics?.f1, 3),
              formatNumber(model.testMetrics?.roc_auc, 3),
              model.isActive ? "Yes" : "No",
            ]),
          },
          notes: [
            "No model dominates every metric. Read the trade-offs rather than " +
              "ranking on a single score.",
            "These figures are measured, not assumed. They describe this data " +
              "and this split.",
          ],
        },
        {
          heading: "Cross-validation",
          intro:
            "Scored on AUC-ROC over stratified folds inside the training split. " +
            "These run higher than the test figures because the training data " +
              "was SMOTE-balanced.",
          table: {
            columns: ["Model", "Mean CV AUC-ROC", "Best hyperparameters", "Test AUC-ROC"],
            align: ["left", "right", "left", "right"],
            rows: models.map((model) => [
              model.displayName,
              formatNumber(model.cvScore, 4),
              Object.entries(model.hyperparameters ?? {})
                .map(([key, value]) => `${key}=${value}`)
                .join(", "),
              formatNumber(model.testMetrics?.roc_auc, 3),
            ]),
          },
        },
        {
          heading: "Confusion matrices on the test split",
          intro:
            "Missed churners are the number that matters most to a retention team.",
          table: {
            columns: ["Model", "True stayed", "False alarm", "Missed churner", "Caught churner"],
            align: ["left", "right", "right", "right", "right"],
            rows: models.map((model) => [
              model.displayName,
              model.testConfusion?.true_negative ?? "—",
              model.testConfusion?.false_positive ?? "—",
              model.testConfusion?.false_negative ?? "—",
              model.testConfusion?.true_positive ?? "—",
            ]),
          },
        },
        ...(await decileSections(models, limit)),
      ],
      footer:
        "Metrics describe model performance on a held-out sample. They do not " +
        "establish that any retention intervention will succeed.",
    },
    summary: { models: models.length, kinds: ["model_performance"] },
  };
}

function singleModelReport(
  model: Awaited<ReturnType<typeof getModel>>,
  limit: number,
): BuiltReport {
  if (!model) throw AppError.notFound("That model does not exist.");
  const confusion = model.testConfusion ?? {};
  const deciles =
    model.decileLift && Array.isArray((model.decileLift as { rows?: unknown[] }).rows)
      ? ((model.decileLift as { rows: Record<string, number>[] }).rows ?? [])
      : [];

  return {
    document: {
      title: `${model.displayName} performance`,
      subtitle: `Model version ${model.version ?? "unknown"}`,
      meta: [
        { label: "Model type", value: model.displayName },
        { label: "Version", value: model.version ?? "—" },
        { label: "Status", value: model.status },
        { label: "Active for prediction", value: model.isActive ? "Yes" : "No" },
        { label: "Dataset", value: model.datasetName ?? "—" },
        { label: "Encoded features", value: String(model.featureCount ?? "—") },
        { label: "Generated", value: new Date().toISOString() },
      ],
      sections: [
        {
          heading: "Test set metrics",
          intro:
            "Measured once, on data the model never saw during training or tuning.",
          facts: [
            { label: "Accuracy", value: percent(model.testMetrics?.accuracy) },
            { label: "Precision", value: percent(model.testMetrics?.precision) },
            { label: "Recall", value: percent(model.testMetrics?.recall) },
            { label: "F1-score", value: formatNumber(model.testMetrics?.f1, 4) },
            { label: "AUC-ROC", value: formatNumber(model.testMetrics?.roc_auc, 4) },
          ],
        },
        {
          heading: "Confusion matrix",
          facts: [
            { label: "Correctly kept", value: String(confusion.true_negative ?? "—") },
            { label: "False alarms", value: String(confusion.false_positive ?? "—") },
            {
              label: "Missed churners",
              value: String(confusion.false_negative ?? "—"),
            },
            { label: "Churners caught", value: String(confusion.true_positive ?? "—") },
          ],
        },
        {
          heading: "Hyperparameters selected by grid search",
          table: {
            columns: ["Parameter", "Value"],
            rows: Object.entries(model.hyperparameters ?? {}).map(
              ([key, value]) => [key, formatScalar(value)] as [string, string],
            ),
          },
        },
        ...activationSection(model),
        ...(deciles.length ? [decileSection(deciles, limit)] : []),
      ],
      footer:
        "SHAP explanations describe model reasoning, not causation. Retention " +
        "suggestions are proposals for human review, not guaranteed outcomes.",
    },
    summary: {
      modelId: model.id,
      modelType: model.modelType,
      testMetrics: model.testMetrics,
    },
  };
}

/** Render a JSON scalar for a report cell. */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

interface ValidationLike {
  issues: {
    severity: string;
    code: string;
    column: string | null;
    message: string;
    detail: string | null;
  }[];
}

function validationSection(
  validation: ValidationLike | null,
): ReportSection[] {
  if (!validation || validation.issues.length === 0) return [];
  return [
    {
      heading: "Validation findings",
      intro:
        "Errors block preprocessing. Warnings and notes are recorded so the " +
        "decision to proceed is deliberate rather than accidental.",
      table: {
        columns: ["Severity", "Code", "Column", "Finding", "Detail"],
        rows: validation.issues.map((issue) => [
          issue.severity,
          issue.code,
          issue.column ?? "—",
          issue.message,
          issue.detail ?? "—",
        ]),
      },
    },
  ];
}

interface PreprocessingRunLike {
  mlPreprocessingId: string;
  status: string;
  encodedFeatureCount: number | null;
  warnings: string[];
  completedAt: string | null;
}

function preprocessingSection(
  runs: PreprocessingRunLike[],
): ReportSection[] {
  if (runs.length === 0) return [];
  return [
    {
      heading: "Preprocessing runs",
      table: {
        columns: ["Run id", "Status", "Encoded features", "Warnings", "Completed"],
        align: ["left", "left", "right", "right", "left"],
        rows: runs.map((run) => [
          run.mlPreprocessingId.slice(0, 12),
          run.status,
          run.encodedFeatureCount ?? "—",
          run.warnings.length,
          run.completedAt ?? "—",
        ]),
      },
    },
  ];
}

/**
 * The activation record, when the model was ever activated.
 *
 * Extracted so the section keeps its type instead of losing it to a spread.
 */
function activationSection(
  model: NonNullable<Awaited<ReturnType<typeof getModel>>>,
): ReportSection[] {
  if (!model.activationReason) return [];
  return [
    {
      heading: "Activation record",
      intro:
        "Which model serves predictions is a human decision. This is who made it and why.",
      facts: [
        { label: "Activated by", value: model.activatedByName ?? "—" },
        { label: "Activated at", value: model.activatedAt ?? "—" },
        { label: "Reason given", value: model.activationReason },
      ],
    },
  ];
}

/** The decile lift table, as a typed section. */
function decileSection(
  deciles: Record<string, number>[],
  limit: number,
): ReportSection {
  return {
    heading: "Decile lift",
    intro:
      "Rank customers by predicted risk and count the churners in each tenth. " +
      "This is the budget question: if the team can only contact the top slice, " +
      "how many real churners are in it?",
    table: {
      columns: [
        "Decile",
        "Customers",
        "Churners",
        "Churn rate",
        "Lift",
        "Cumulative captured",
      ],
      align: ["left", "right", "right", "right", "right", "right"],
      rows: deciles.slice(0, limit).map((row) => [
        row.decile,
        row.customers,
        row.churners,
        percent(row.churn_rate),
        `${row.lift}x`,
        percent(row.cumulative_captured),
      ]),
    },
  };
}

async function decileSections(
  models: Awaited<ReturnType<typeof listModels>>,
  limit: number,
): Promise<NonNullable<ReportDocument["sections"]>> {
  const withLift = models.filter(
    (model) =>
      model.decileLift &&
      Array.isArray((model.decileLift as { rows?: unknown[] }).rows) &&
      ((model.decileLift as { rows: unknown[] }).rows.length ?? 0) > 0,
  );
  if (withLift.length === 0) return [];

  return [
    {
      heading: "Decile lift by model",
      intro:
        "Churn rate in each tenth of the customer base, ranked by predicted risk.",
      table: {
        columns: ["Model", ...Array.from({ length: limit }, (_, i) => `D${i + 1}`)],
        align: ["left", ...Array.from({ length: limit }, () => "right" as const)],
        rows: withLift.map((model) => {
          const rows = (model.decileLift as { rows: Record<string, number>[] }).rows;
          return [
            model.displayName,
            ...rows.slice(0, limit).map((row) => `${row.lift}x`),
          ];
        }),
      },
      notes: [
        "A lift above 1x means that decile contains churners at a higher rate " +
          "than the base rate.",
      ],
    },
  ];
}

async function buildPredictionSummaryReport(
  input: GenerateReportInput,
  limit: number,
): Promise<BuiltReport> {
  const db = await getDatabase();

  const totals = await db.query<{
    total: string;
    scored: string;
    high: string;
    medium: string;
    low: string;
    mean_probability: string | null;
  }>(
    `SELECT
       (SELECT count(*) FROM customers) AS total,
       (SELECT count(*) FROM predictions) AS scored,
       (SELECT count(*) FROM predictions WHERE risk_category = 'high') AS high,
       (SELECT count(*) FROM predictions WHERE risk_category = 'medium') AS medium,
       (SELECT count(*) FROM predictions WHERE risk_category = 'low') AS low,
       (SELECT avg(churn_probability) FROM predictions) AS mean_probability`,
  );
  const row = totals.rows[0];
  if (Number(row.scored) === 0) {
    throw AppError.unprocessable(
      "No predictions have been generated yet.",
      { nextAction: "Activate a model and generate predictions first." },
    );
  }

  const top = await db.query<{
    external_id: string;
    display_name: string | null;
    churn_probability: string;
    risk_category: string;
    model_name: string | null;
    model_version: string;
  }>(
    `SELECT c.external_id, c.display_name, p.churn_probability, p.risk_category,
            m.display_name AS model_name, p.model_version
       FROM predictions p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN model_results m ON m.id = p.model_result_id
      ORDER BY p.churn_probability DESC
      LIMIT $1`,
    [limit],
  );

  return {
    document: {
      title: "Prediction summary",
      subtitle:
        "Current churn risk across the customer base, with the highest-risk customers listed first.",
      meta: [
        { label: "Customers loaded", value: Number(row.total).toLocaleString() },
        { label: "Customers scored", value: Number(row.scored).toLocaleString() },
        { label: "Generated", value: new Date().toISOString() },
      ],
      sections: [
        {
          heading: "Risk distribution",
          facts: [
            { label: "High risk", value: Number(row.high).toLocaleString() },
            { label: "Medium risk", value: Number(row.medium).toLocaleString() },
            { label: "Low risk", value: Number(row.low).toLocaleString() },
            {
              label: "Mean probability",
              value: percent(Number(row.mean_probability ?? 0), 2),
            },
          ],
          notes: [
            "Risk bands come from configurable thresholds stored with each " +
              "prediction, so a band can always be re-derived from its probability.",
          ],
        },
        {
          heading: `Highest-risk customers (top ${top.rows.length})`,
          intro:
            "Ranked by predicted probability. Ranking quality is what matters for " +
            "deciding who to contact first.",
          table: {
            columns: ["Customer", "Name", "Probability", "Risk", "Model", "Version"],
            align: ["left", "left", "right", "left", "left", "left"],
            rows: top.rows.map((customer) => [
              customer.external_id,
              customer.display_name ?? "—",
              percent(Number(customer.churn_probability), 2),
              customer.risk_category,
              customer.model_name ?? "—",
              customer.model_version,
            ]),
          },
        },
      ],
      footer:
        "A churn probability is the model's estimate, not a prediction of " +
        "certain loss. Treat it as a ranking for prioritising attention.",
    },
    summary: {
      scored: Number(row.scored),
      high: Number(row.high),
      medium: Number(row.medium),
      low: Number(row.low),
    },
  };
}

async function buildRetentionSummaryReport(
  input: GenerateReportInput,
  limit: number,
): Promise<BuiltReport> {
  const summary = await getRetentionSummary();
  if (summary.total === 0) {
    throw AppError.unprocessable(
      "There are no retention actions to report on yet.",
      { nextAction: "Create a retention action from a customer page first." },
    );
  }

  const db = await getDatabase();
  const actions = await db.query<{
    external_id: string;
    title: string;
    status: string;
    priority: string;
    due_date: string | null;
    assigned_to_name: string | null;
    churn_probability_at_creation: string | null;
  }>(
    `SELECT c.external_id, a.title, a.status, a.priority, a.due_date,
            u.full_name AS assigned_to_name, a.churn_probability_at_creation
       FROM customer_retention_actions a
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN users u ON u.id = a.assigned_to
      ORDER BY
        CASE a.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1
                      WHEN 'suggested' THEN 2 ELSE 3 END,
        a.due_date NULLS LAST
      LIMIT $1`,
    [limit],
  );

  return {
    document: {
      title: "Retention activity summary",
      subtitle: "Actions created from model findings, and where they stand.",
      meta: [
        { label: "Total actions", value: String(summary.total) },
        { label: "Overdue", value: String(summary.overdue) },
        { label: "Due within 7 days", value: String(summary.dueSoon) },
        { label: "Unassigned", value: String(summary.unassigned) },
        { label: "Generated", value: new Date().toISOString() },
      ],
      sections: [
        {
          heading: "Actions by status",
          bars: Object.entries(summary.byStatus).map(([status, count]) => ({
            label: status,
            value: count,
            display: String(count),
            tone: status === "completed" ? "protective" : status === "cancelled" ? "neutral" : "risk",
          })),
        },
        {
          heading: "Actions by priority",
          bars: Object.entries(summary.byPriority).map(([priority, count]) => ({
            label: priority,
            value: count,
            display: String(count),
            tone: priority === "critical" || priority === "high" ? "risk" : "neutral",
          })),
        },
        {
          heading: "Current actions",
          table: {
            columns: [
              "Customer",
              "Action",
              "Status",
              "Priority",
              "Due",
              "Assigned to",
              "Risk at creation",
            ],
            align: [
              "left",
              "left",
              "left",
              "left",
              "left",
              "left",
              "right",
            ],
            rows: actions.rows.map((action) => [
              action.external_id,
              action.title,
              action.status,
              action.priority,
              action.due_date ?? "—",
              action.assigned_to_name ?? "Unassigned",
              percent(
                action.churn_probability_at_creation
                  ? Number(action.churn_probability_at_creation)
                  : null,
              ),
            ]),
          },
          notes: [
            "Strategies are model-informed suggestions. Completing an action " +
              "records that the work was done, not that the customer was saved.",
          ],
        },
      ],
      footer:
        "Retention outcomes depend on the intervention and the customer. This " +
        "report records activity, not commercial results.",
    },
    summary: { ...summary },
  };
}

async function buildDatasetSummaryReport(
  input: GenerateReportInput,
  limit: number,
): Promise<BuiltReport> {
  if (!input.datasetId || !isUuid(input.datasetId)) {
    throw AppError.badRequest("Choose a dataset for this report.");
  }
  const { getDataset, getDatasetValidation } = await import("./datasets");
  const dataset = await getDataset(input.datasetId);
  if (!dataset) throw AppError.notFound("That dataset does not exist.");
  const validation = await getDatasetValidation(input.datasetId);

  return {
    document: {
      title: `Dataset summary: ${dataset.name}`,
      subtitle:
        "Structure and validation results, measured from the uploaded file.",
      meta: [
        { label: "File", value: dataset.originalFilename },
        { label: "Size", value: `${(dataset.sizeBytes / 1024).toFixed(1)} KB` },
        { label: "Rows", value: String(dataset.rowCount ?? "—") },
        { label: "Columns", value: String(dataset.columnCount ?? "—") },
        { label: "Target column", value: dataset.targetColumn ?? "—" },
        { label: "Churn rate", value: percent(dataset.targetPositiveRate, 2) },
        { label: "Duplicate rows", value: String(dataset.duplicateRowCount ?? "—") },
        { label: "Validation", value: validation?.status ?? "not run" },
        { label: "Generated", value: new Date().toISOString() },
      ],
      sections: [
        {
          heading: "Target distribution",
          facts: Object.entries(dataset.targetDistribution ?? {}).map(([key, value]) => ({
            label: key === "yes" ? "Churned" : key === "no" ? "Stayed" : key,
            value: `${value.toLocaleString()} (${percent(
              value / Math.max(1, Object.values(dataset.targetDistribution ?? {}).reduce((a, b) => a + b, 0)),
            )})`,
          })),
        },
        {
          heading: "Columns",
          table: {
            columns: [
              "#",
              "Column",
              "Type",
              "Non-null",
              "Null",
              "Distinct",
              "Target",
            ],
            align: ["right", "left", "left", "right", "right", "right", "center"],
            rows: dataset.columns.slice(0, limit).map((column) => [
              column.position,
              column.name,
              column.inferredType,
              column.nonNullCount,
              column.nullCount,
              column.distinctCount,
              column.isTarget ? "yes" : "",
            ]),
          },
        },
        ...validationSection(validation),
        ...preprocessingSection(dataset.preprocessingRuns),
      ],
      footer:
        "Dataset statistics are calculated from the uploaded file. They are not " +
        "reference values for any published dataset.",
    },
    summary: {
      datasetId: dataset.id,
      rows: dataset.rowCount,
      columns: dataset.columnCount,
      validationStatus: validation?.status ?? null,
    },
  };
}

async function buildShapReport(
  input: GenerateReportInput,
  limit: number,
): Promise<BuiltReport> {
  if (!input.modelResultId) {
    throw AppError.badRequest("Choose a model for the feature importance report.");
  }
  const model = await getModel(input.modelResultId);
  if (!model) throw AppError.notFound("That model does not exist.");

  // Global importance is measured, not stored, so this report has to compute it.
  const { generateGlobalExplanation } = await import("./customers");
  const explanation = await generateGlobalExplanation(input.modelResultId, {
    sampleSize: Math.min(limit * 20, 1000),
  });

  return {
    document: {
      title: `Global feature importance: ${model.displayName}`,
      subtitle:
        "Mean absolute SHAP value per feature across sampled customers.",
      meta: [
        { label: "Model", value: model.displayName },
        { label: "Version", value: model.version ?? "—" },
        { label: "Customers sampled", value: String(explanation.sampleSize) },
        { label: "Generated", value: new Date().toISOString() },
      ],
      sections: [
        {
          heading: "Ranked drivers",
          // The caveat travels with the figures, so a printed report cannot be
          // read without it.
          intro:
            explanation.note ??
            "Mean absolute SHAP values. These show how the model weighted each " +
              "feature across the sampled customers, not what causes churn.",
          bars: explanation.features.slice(0, limit).map((feature) => ({
            label: feature.label,
            value: feature.meanAbsShap,
            display: feature.meanAbsShap.toFixed(4),
            tone:
              feature.direction === "increases_risk"
                ? "risk"
                : feature.direction === "reduces_risk"
                  ? "protective"
                  : "neutral",
          })),
        },
        {
          heading: "Feature detail",
          table: {
            columns: ["Rank", "Feature", "Source column", "Mean |SHAP|", "Direction"],
            align: ["right", "left", "left", "right", "left"],
            rows: explanation.features.slice(0, limit).map((feature) => [
              feature.rank,
              feature.label,
              feature.sourceColumn,
              feature.meanAbsShap.toFixed(5),
              feature.direction.replace(/_/g, " "),
            ]),
          },
        },
        {
          heading: "Model-risk review",
          intro:
            "Technical performance does not make a model unbiased. These are the " +
            "features a person has flagged for review.",
          table: {
            columns: ["Feature", "Concern", "Severity", "Status", "Notes"],
            rows: model.riskReviews.length
              ? model.riskReviews.map((review) => [
                  review.feature,
                  review.concernType.replace(/_/g, " "),
                  review.severity,
                  review.status,
                  review.notes ?? "—",
                ])
              : [["—", "No features flagged", "—", "—", "—"]],
          },
        },
      ],
      footer: explanation.disclaimer,
    },
    summary: {
      modelId: model.id,
      sampleSize: explanation.sampleSize,
      topFeature: explanation.features[0]?.label ?? null,
    },
  };
}

async function buildAuditReport(
  input: GenerateReportInput,
  limit: number,
): Promise<BuiltReport> {
  const db = await getDatabase();
  const entries = await db.query<{
    created_at: string;
    actor_email: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    outcome: string;
  }>(
    `SELECT created_at, actor_email, action, resource_type, resource_id, outcome
       FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );

  return {
    document: {
      title: "Audit trail",
      subtitle: "Consequential activity, most recent first.",
      meta: [
        { label: "Entries shown", value: String(entries.rows.length) },
        { label: "Generated", value: new Date().toISOString() },
      ],
      sections: [
        {
          heading: "Activity",
          table: {
            columns: ["When", "Actor", "Action", "Resource", "Outcome"],
            align: ["left", "left", "left", "left", "left"],
            rows: entries.rows.map((entry) => [
              entry.created_at,
              entry.actor_email ?? "system",
              entry.action,
              entry.resource_type
                ? `${entry.resource_type}${entry.resource_id ? ` ${entry.resource_id.slice(0, 8)}` : ""}`
                : "—",
              entry.outcome,
            ]),
          },
          notes: [
            "The audit trail is append-only: entries cannot be edited or " +
              "deleted, by the application or directly in the database.",
            "Secrets and credentials are never written to the audit log.",
          ],
        },
      ],
      footer: "Generated from the audit log. Entries are immutable once written.",
    },
    summary: { entries: entries.rows.length },
  };
}

/** Read a generated report's bytes for download. */
export async function readReportFile(reportId: string): Promise<{
  buffer: Buffer;
  filename: string;
  contentType: string;
}> {
  await requireActor();
  if (!isUuid(reportId)) throw AppError.notFound("That report does not exist.");
  const db = await getDatabase();
  const result = await db.query<{
    storage_path: string | null;
    content_type: string | null;
    title: string;
    format: ReportFormat;
  }>("SELECT storage_path, content_type, title, format FROM reports WHERE id = $1", [
    reportId,
  ]);
  const row = result.rows[0];
  if (!row) throw AppError.notFound("That report does not exist.");
  if (!row.storage_path) {
    throw AppError.unprocessable("That report has no stored file.", {
      nextAction: "Generate the report again.",
    });
  }

  const buffer = await storage().get(row.storage_path);
  const safeTitle = row.title.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "report";
  return {
    buffer,
    filename: `${safeTitle}${extensionFor(row.storage_path) || (row.format === "pdf" ? ".pdf" : ".csv")}`,
    contentType: row.content_type ?? CONTENT_TYPES[row.format],
  };
}

// ---------------------------------------------------------------------------
// Audit trail reader
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
}

export async function listAuditEntries(
  options: {
    action?: string;
    actorId?: string;
    outcome?: string;
    resourceType?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ items: AuditEntry[]; total: number; page: number; pageSize: number; pageCount: number }> {
  await requireActor();
  const db = await getDatabase();
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 500);
  const page = Math.max(options.page ?? 1, 1);
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (options.action && options.action !== "all") {
    params.push(options.action);
    clauses.push(`action = $${params.length}`);
  }
  if (options.actorId && isUuid(options.actorId)) {
    params.push(options.actorId);
    clauses.push(`actor_user_id = $${params.length}`);
  }
  if (options.outcome && options.outcome !== "all") {
    params.push(options.outcome);
    clauses.push(`outcome = $${params.length}`);
  }
  if (options.resourceType && options.resourceType !== "all") {
    params.push(options.resourceType);
    clauses.push(`resource_type = $${params.length}`);
  }
  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim()}%`);
    const index = params.length;
    clauses.push(
      `(action ILIKE $${index} OR actor_email ILIKE $${index} OR resource_id ILIKE $${index})`,
    );
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const count = await db.query<{ count: string }>(
    `SELECT count(*) AS count FROM audit_logs ${where}`,
    params,
  );
  const total = Number(count.rows[0].count);

  params.push(pageSize, (page - 1) * pageSize);
  const rows = await db.query<{
    id: string;
    created_at: string;
    actor_user_id: string | null;
    actor_email: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    outcome: string;
    metadata: Record<string, unknown>;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT id, created_at, actor_user_id, actor_email, action, resource_type,
            resource_id, outcome, metadata, ip_address, user_agent
       FROM audit_logs ${where}
      ORDER BY created_at DESC, id DESC
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
      createdAt: row.created_at,
      actorUserId: row.actor_user_id,
      actorEmail: row.actor_email,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      outcome: row.outcome,
      metadata: row.metadata ?? {},
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    })),
  };
}

export async function listAuditActions(): Promise<string[]> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<{ action: string }>(
    "SELECT DISTINCT action FROM audit_logs ORDER BY action",
  );
  return result.rows.map((row) => row.action);
}

/** Health of the machine learning service, for the status panel. */
export async function getDependencyStatus(): Promise<{
  ml: Awaited<ReturnType<typeof mlServiceReachable>>;
}> {
  await requireActor();
  return { ml: await mlServiceReachable() };
}
