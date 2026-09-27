/**
 * Dashboard figures.
 *
 * Every number here is counted from stored rows. There is no reference value
 * for a "typical" churn rate, and nothing falls back to a constant when a
 * query returns nothing: an empty platform reports zero, not a sample.
 */

import "server-only";

import { getDatabase } from "../../../db/client";
import { requireActor } from "./access";

export interface DashboardOverview {
  customers: {
    total: number;
    evaluated: number;
    unscored: number;
    high: number;
    medium: number;
    low: number;
  };
  model: {
    id: string | null;
    displayName: string | null;
    version: string | null;
    modelType: string | null;
    activatedAt: string | null;
    activatedByName: string | null;
    testMetrics: Record<string, number> | null;
    trainedModels: number;
    failedModels: number;
    runningRuns: number;
  };
  dataset: {
    id: string | null;
    name: string | null;
    status: string | null;
    rowCount: number | null;
    validated: number;
    invalid: number;
  };
  retention: {
    open: number;
    overdue: number;
    dueSoon: number;
    completed: number;
    total: number;
  };
  recentPredictions: {
    id: string;
    customerId: string;
    externalId: string;
    churnProbability: number;
    riskCategory: string;
    modelName: string | null;
    predictedAt: string;
    hasExplanation: boolean;
  }[];
  recentActions: {
    id: string;
    title: string;
    customerExternalId: string;
    status: string;
    priority: string;
    dueDate: string | null;
    createdAt: string;
  }[];
  activity: {
    totalPredictions: number;
    explanations: number;
    highRiskShare: number;
    coverage: number;
  };
}

export async function getDashboardOverview(): Promise<DashboardOverview> {
  await requireActor();
  const db = await getDatabase();

  const [totals, model, datasets, retention, predictions, actions, activity] =
    await Promise.all([
      db.query<{
        total: string;
        evaluated: string;
        high: string;
        medium: string;
        low: string;
      }>(
        `SELECT
           (SELECT count(*) FROM customers) AS total,
           (SELECT count(*) FROM predictions) AS evaluated,
           (SELECT count(*) FROM predictions WHERE risk_category = 'high') AS high,
           (SELECT count(*) FROM predictions WHERE risk_category = 'medium') AS medium,
           (SELECT count(*) FROM predictions WHERE risk_category = 'low') AS low`,
      ),
      db.query<{
        id: string | null;
        display_name: string | null;
        version: string | null;
        model_type: string | null;
        activated_at: string | null;
        activated_by_name: string | null;
        test_metrics: Record<string, number> | null;
        trained: string;
        failed: string;
        running: string;
      }>(
        `SELECT
           m.id, m.display_name, m.version, m.model_type, m.activated_at,
           u.full_name AS activated_by_name, m.test_metrics,
           (SELECT count(*) FROM model_results WHERE status = 'completed') AS trained,
           (SELECT count(*) FROM model_results WHERE status = 'failed') AS failed,
           (SELECT count(*) FROM model_runs
             WHERE status IN ('queued','running','evaluating')) AS running
         FROM model_results m
         LEFT JOIN users u ON u.id = m.activated_by
        WHERE m.is_active
        LIMIT 1`,
      ),
      db.query<{
        id: string | null;
        name: string | null;
        status: string | null;
        row_count: number | null;
        validated: string;
        invalid: string;
      }>(
        `SELECT
           d.id, d.name, d.status, d.row_count,
           (SELECT count(*) FROM datasets WHERE status = 'validated' AND deleted_at IS NULL)
             AS validated,
           (SELECT count(*) FROM datasets WHERE status = 'invalid' AND deleted_at IS NULL)
             AS invalid
         FROM datasets d
        WHERE d.deleted_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT 1`,
      ),
      db.query<{
        open: string;
        overdue: string;
        due_soon: string;
        completed: string;
        total: string;
      }>(
        `SELECT
           (SELECT count(*) FROM customer_retention_actions
             WHERE status NOT IN ('completed','cancelled')) AS open,
           (SELECT count(*) FROM customer_retention_actions
             WHERE due_date < current_date
               AND status NOT IN ('completed','cancelled')) AS overdue,
           (SELECT count(*) FROM customer_retention_actions
             WHERE due_date BETWEEN current_date AND current_date + 7
               AND status NOT IN ('completed','cancelled')) AS due_soon,
           (SELECT count(*) FROM customer_retention_actions
             WHERE status = 'completed') AS completed,
           (SELECT count(*) FROM customer_retention_actions) AS total`,
      ),
      db.query<{
        id: string;
        customer_id: string;
        external_id: string;
        churn_probability: string;
        risk_category: string;
        model_name: string | null;
        predicted_at: string;
        has_explanation: string;
      }>(
        `SELECT p.id, c.id AS customer_id, c.external_id, p.churn_probability,
                p.risk_category, m.display_name AS model_name, p.predicted_at,
                (SELECT count(*) FROM prediction_explanations e
                  WHERE e.prediction_id = p.id AND e.status = 'completed')
                  AS has_explanation
           FROM predictions p
           JOIN customers c ON c.id = p.customer_id
           LEFT JOIN model_results m ON m.id = p.model_result_id
          ORDER BY p.predicted_at DESC
          LIMIT 8`,
      ),
      db.query<{
        id: string;
        title: string;
        external_id: string;
        status: string;
        priority: string;
        due_date: string | null;
        created_at: string;
      }>(
        `SELECT a.id, a.title, c.external_id, a.status, a.priority, a.due_date,
                a.created_at
           FROM customer_retention_actions a
           JOIN customers c ON c.id = a.customer_id
          ORDER BY a.created_at DESC
          LIMIT 8`,
      ),
      db.query<{
        total_predictions: string;
        explanations: string;
        high: string;
      }>(
        `SELECT
           (SELECT count(*) FROM predictions) AS total_predictions,
           (SELECT count(*) FROM prediction_explanations WHERE status = 'completed')
             AS explanations,
           (SELECT count(*) FROM predictions WHERE risk_category = 'high') AS high`,
      ),
    ]);

  const t = totals.rows[0];
  const a = activity.rows[0];
  const total = Number(t.total);
  const evaluated = Number(t.evaluated);
  const high = Number(t.high);

  return {
    customers: {
      total,
      evaluated,
      unscored: Math.max(0, total - evaluated),
      high,
      medium: Number(t.medium),
      low: Number(t.low),
    },
    model: {
      id: model.rows[0]?.id ?? null,
      displayName: model.rows[0]?.display_name ?? null,
      version: model.rows[0]?.version ?? null,
      modelType: model.rows[0]?.model_type ?? null,
      activatedAt: model.rows[0]?.activated_at ?? null,
      activatedByName: model.rows[0]?.activated_by_name ?? null,
      testMetrics: model.rows[0]?.test_metrics ?? null,
      trainedModels: Number(model.rows[0]?.trained ?? 0),
      failedModels: Number(model.rows[0]?.failed ?? 0),
      runningRuns: Number(model.rows[0]?.running ?? 0),
    },
    dataset: {
      id: datasets.rows[0]?.id ?? null,
      name: datasets.rows[0]?.name ?? null,
      status: datasets.rows[0]?.status ?? null,
      rowCount: datasets.rows[0]?.row_count ?? null,
      validated: Number(datasets.rows[0]?.validated ?? 0),
      invalid: Number(datasets.rows[0]?.invalid ?? 0),
    },
    retention: {
      open: Number(retention.rows[0]?.open ?? 0),
      overdue: Number(retention.rows[0]?.overdue ?? 0),
      dueSoon: Number(retention.rows[0]?.due_soon ?? 0),
      completed: Number(retention.rows[0]?.completed ?? 0),
      total: Number(retention.rows[0]?.total ?? 0),
    },
    recentPredictions: predictions.rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      externalId: row.external_id,
      churnProbability: Number(row.churn_probability),
      riskCategory: row.risk_category,
      modelName: row.model_name,
      predictedAt: row.predicted_at,
      hasExplanation: Number(row.has_explanation) > 0,
    })),
    recentActions: actions.rows.map((row) => ({
      id: row.id,
      title: row.title,
      customerExternalId: row.external_id,
      status: row.status,
      priority: row.priority,
      dueDate: row.due_date,
      createdAt: row.created_at,
    })),
    activity: {
      totalPredictions: Number(a.total_predictions),
      explanations: Number(a.explanations),
      highRiskShare: evaluated > 0 ? high / evaluated : 0,
      coverage: total > 0 ? evaluated / total : 0,
    },
  };
}
