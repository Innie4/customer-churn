/**
 * Retention strategies and the actions that come out of them.
 *
 * A strategy is a model-informed suggestion. An action is a commitment a person
 * made. Keeping them as separate records means "we suggested it and nobody did
 * it" is a visible, countable outcome rather than something the schema hides.
 */

import "server-only";

import { getDatabase } from "../../../db/client";
import { AppError } from "../api";
import { AUDIT, recordAudit } from "../audit";
import { requireActor, requireCapability } from "./access";
import { isUuid } from "./datasets";

export type ActionStatus =
  | "suggested"
  | "planned"
  | "in_progress"
  | "completed"
  | "cancelled";

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  suggested: "Suggested",
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Which transitions the workflow allows from each status. */
export const ACTION_TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  suggested: ["planned", "in_progress", "cancelled"],
  planned: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export interface StrategySummary {
  id: string;
  title: string;
  description: string;
  triggeringCondition: string;
  riskDriver: string;
  sourceColumn: string | null;
  suggestedIntervention: string;
  priority: string;
  status: string;
  notes: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  linkedModelId: string | null;
  openActionCount: number;
  totalActionCount: number;
}

export interface ActionSummary {
  id: string;
  customerId: string;
  customerExternalId: string;
  customerName: string | null;
  predictionId: string | null;
  strategyId: string | null;
  strategyTitle: string | null;
  title: string;
  description: string | null;
  status: ActionStatus;
  priority: string;
  assignedTo: string | null;
  assignedToName: string | null;
  dueDate: string | null;
  notes: string | null;
  churnProbabilityAtCreation: number | null;
  riskCategory: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionEvent {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  changedByName: string | null;
  changedAt: string;
}

interface StrategyRow {
  id: string;
  title: string;
  description: string;
  triggering_condition: string;
  risk_driver: string;
  source_column: string | null;
  suggested_intervention: string;
  priority: string;
  status: string;
  notes: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  derived_from_model_result_id: string | null;
  open_action_count: string;
  total_action_count: string;
}

const STRATEGY_SELECT = `
  SELECT s.*, a.full_name AS approved_by_name,
         (SELECT count(*) FROM customer_retention_actions r
           WHERE r.strategy_id = s.id
             AND r.status NOT IN ('completed','cancelled')) AS open_action_count,
         (SELECT count(*) FROM customer_retention_actions r
           WHERE r.strategy_id = s.id) AS total_action_count
    FROM retention_strategies s
    LEFT JOIN users a ON a.id = s.approved_by
`;

function toStrategy(row: StrategyRow): StrategySummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    triggeringCondition: row.triggering_condition,
    riskDriver: row.risk_driver,
    sourceColumn: row.source_column,
    suggestedIntervention: row.suggested_intervention,
    priority: row.priority,
    status: row.status,
    notes: row.notes,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedModelId: row.derived_from_model_result_id,
    openActionCount: Number(row.open_action_count),
    totalActionCount: Number(row.total_action_count),
  };
}

export async function listStrategies(
  options: { status?: string } = {},
): Promise<StrategySummary[]> {
  await requireActor();
  const db = await getDatabase();
  const params: unknown[] = [];
  let where = "";
  if (options.status && options.status !== "all") {
    params.push(options.status);
    where = "WHERE s.status = $1";
  }
  const result = await db.query<StrategyRow>(
    `${STRATEGY_SELECT} ${where} ORDER BY
       CASE s.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                       WHEN 'medium' THEN 2 ELSE 3 END,
       s.title`,
    params,
  );
  return result.rows.map(toStrategy);
}

export async function getStrategy(strategyId: string): Promise<StrategySummary | null> {
  await requireActor();
  if (!isUuid(strategyId)) return null;
  const db = await getDatabase();
  const result = await db.query<StrategyRow>(
    `${STRATEGY_SELECT} WHERE s.id = $1`,
    [strategyId],
  );
  return result.rows[0] ? toStrategy(result.rows[0]) : null;
}

export interface StrategyInput {
  title: string;
  description: string;
  triggeringCondition: string;
  riskDriver: string;
  sourceColumn?: string | null;
  suggestedIntervention: string;
  priority: string;
  notes?: string | null;
  derivedFromModelResultId?: string | null;
}

function validateStrategy(input: StrategyInput): void {
  const fields: Record<string, string> = {};
  if (input.title.trim().length < 3) {
    fields.title = "Give the strategy a title of at least 3 characters.";
  }
  if (input.description.trim().length < 10) {
    fields.description = "Describe the strategy in at least 10 characters.";
  }
  if (input.triggeringCondition.trim().length < 5) {
    fields.triggeringCondition = "State the condition that should trigger this.";
  }
  if (input.riskDriver.trim().length < 2) {
    fields.riskDriver = "Name the model driver this responds to.";
  }
  if (input.suggestedIntervention.trim().length < 10) {
    fields.suggestedIntervention =
      "Describe the intervention in at least 10 characters.";
  }
  if (!["low", "medium", "high", "critical"].includes(input.priority)) {
    fields.priority = "Choose a priority.";
  }
  if (Object.keys(fields).length > 0) {
    throw AppError.unprocessable("Some strategy fields need attention.", { fields });
  }
}

export async function createStrategy(
  input: StrategyInput,
): Promise<StrategySummary> {
  const actor = await requireCapability("manageModels");
  validateStrategy(input);
  const db = await getDatabase();
  const result = await db.query<{ id: string }>(
    `INSERT INTO retention_strategies
       (title, description, triggering_condition, risk_driver, source_column,
        suggested_intervention, priority, notes, derived_from_model_result_id,
        status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)
     RETURNING id`,
    [
      input.title.trim(),
      input.description.trim(),
      input.triggeringCondition.trim(),
      input.riskDriver.trim(),
      input.sourceColumn?.trim() || null,
      input.suggestedIntervention.trim(),
      input.priority,
      input.notes ?? null,
      input.derivedFromModelResultId ?? null,
      actor.id,
    ],
  );
  await recordAudit({
    action: AUDIT.strategyCreated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "strategy",
    resourceId: result.rows[0].id,
    metadata: { title: input.title.trim(), riskDriver: input.riskDriver.trim() },
  });
  const created = await getStrategy(result.rows[0].id);
  if (!created) throw AppError.internal("The strategy could not be read back.");
  return created;
}

export async function updateStrategy(
  strategyId: string,
  input: Partial<StrategyInput>,
): Promise<StrategySummary> {
  const actor = await requireCapability("manageModels");
  if (!isUuid(strategyId)) throw AppError.notFound("That strategy does not exist.");
  const db = await getDatabase();
  const result = await db.query(
    `UPDATE retention_strategies
        SET title = COALESCE($2, title),
            description = COALESCE($3, description),
            triggering_condition = COALESCE($4, triggering_condition),
            risk_driver = COALESCE($5, risk_driver),
            source_column = COALESCE($6, source_column),
            suggested_intervention = COALESCE($7, suggested_intervention),
            priority = COALESCE($8, priority),
            notes = COALESCE($9, notes)
      WHERE id = $1 RETURNING id`,
    [
      strategyId,
      input.title?.trim() ?? null,
      input.description?.trim() ?? null,
      input.triggeringCondition?.trim() ?? null,
      input.riskDriver?.trim() ?? null,
      input.sourceColumn ?? null,
      input.suggestedIntervention?.trim() ?? null,
      input.priority ?? null,
      input.notes ?? null,
    ],
  );
  if (!result.rows.length) {
    throw AppError.notFound("That strategy does not exist.");
  }
  await recordAudit({
    action: AUDIT.strategyUpdated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "strategy",
    resourceId: strategyId,
    metadata: { fields: Object.keys(input) },
  });
  const updated = await getStrategy(strategyId);
  if (!updated) throw AppError.internal("The strategy could not be read back.");
  return updated;
}

/** Move a strategy through its review workflow. */
export async function setStrategyStatus(
  strategyId: string,
  status: "proposed" | "approved" | "rejected" | "retired" | "draft",
  notes?: string,
): Promise<StrategySummary> {
  const actor = await requireCapability("manageModels");
  if (!isUuid(strategyId)) throw AppError.notFound("That strategy does not exist.");

  // Approval is attributed. A strategy cannot become approved without a named
  // approver, and the schema enforces that too.
  const isApproval = status === "approved";
  const db = await getDatabase();
  const result = await db.query(
    `UPDATE retention_strategies
        SET status = $2,
            approved_by = CASE WHEN $3 THEN $4 ELSE approved_by END,
            approved_at = CASE WHEN $3 THEN now() ELSE approved_at END,
            notes = COALESCE($5, notes)
      WHERE id = $1 RETURNING id`,
    [strategyId, status, isApproval, actor.id, notes ?? null],
  );
  if (!result.rows.length) {
    throw AppError.notFound("That strategy does not exist.");
  }
  await recordAudit({
    action: isApproval ? AUDIT.strategyApproved : AUDIT.strategyUpdated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "strategy",
    resourceId: strategyId,
    metadata: { status },
  });
  const updated = await getStrategy(strategyId);
  if (!updated) throw AppError.internal("The strategy could not be read back.");
  return updated;
}

interface ActionRow {
  id: string;
  customer_id: string;
  customer_external_id: string;
  customer_name: string | null;
  prediction_id: string | null;
  strategy_id: string | null;
  strategy_title: string | null;
  title: string;
  description: string | null;
  status: ActionStatus;
  priority: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  due_date: string | null;
  notes: string | null;
  churn_probability_at_creation: string | null;
  risk_category: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const ACTION_SELECT = `
  SELECT a.*, c.external_id AS customer_external_id, c.display_name AS customer_name,
         s.title AS strategy_title, u.full_name AS assigned_to_name,
         cb.full_name AS created_by_name, p.risk_category
    FROM customer_retention_actions a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN retention_strategies s ON s.id = a.strategy_id
    LEFT JOIN users u ON u.id = a.assigned_to
    LEFT JOIN users cb ON cb.id = a.created_by
    LEFT JOIN predictions p ON p.id = a.prediction_id
`;

function toAction(row: ActionRow): ActionSummary {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerExternalId: row.customer_external_id,
    customerName: row.customer_name,
    predictionId: row.prediction_id,
    strategyId: row.strategy_id,
    strategyTitle: row.strategy_title,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    dueDate: row.due_date,
    notes: row.notes,
    churnProbabilityAtCreation: row.churn_probability_at_creation
      ? Number(row.churn_probability_at_creation)
      : null,
    riskCategory: row.risk_category,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listActions(
  options: {
    status?: string;
    customerId?: string;
    assignedTo?: string;
    priority?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ items: ActionSummary[]; total: number; page: number; pageSize: number; pageCount: number }> {
  await requireActor();
  const db = await getDatabase();
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 200);
  const page = Math.max(options.page ?? 1, 1);
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (options.status && options.status !== "all") {
    params.push(options.status);
    clauses.push(`a.status = $${params.length}`);
  }
  if (options.customerId && isUuid(options.customerId)) {
    params.push(options.customerId);
    clauses.push(`a.customer_id = $${params.length}`);
  }
  if (options.assignedTo === "me") {
    clauses.push("a.assigned_to = (SELECT id FROM users WHERE lower(email) = lower($1))");
    params.push("me");
  } else if (options.assignedTo && isUuid(options.assignedTo)) {
    params.push(options.assignedTo);
    clauses.push(`a.assigned_to = $${params.length}`);
  }
  if (options.priority && options.priority !== "all") {
    params.push(options.priority);
    clauses.push(`a.priority = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const count = await db.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM customer_retention_actions a
       JOIN customers c ON c.id = a.customer_id
       ${where}`,
    params,
  );
  const total = Number(count.rows[0].count);

  params.push(pageSize, (page - 1) * pageSize);
  const rows = await db.query<ActionRow>(
    `${ACTION_SELECT} ${where}
      ORDER BY
        CASE a.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1
                      WHEN 'suggested' THEN 2 WHEN 'completed' THEN 3
                      ELSE 4 END,
        a.due_date NULLS LAST, a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    items: rows.rows.map(toAction),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getAction(actionId: string): Promise<ActionSummary | null> {
  await requireActor();
  if (!isUuid(actionId)) return null;
  const db = await getDatabase();
  const result = await db.query<ActionRow>(
    `${ACTION_SELECT} WHERE a.id = $1`,
    [actionId],
  );
  return result.rows[0] ? toAction(result.rows[0]) : null;
}

export async function getActionHistory(actionId: string): Promise<ActionEvent[]> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<{
    id: string;
    from_status: string | null;
    to_status: string;
    note: string | null;
    changed_by_name: string | null;
    changed_at: string;
  }>(
    `SELECT e.id, e.from_status, e.to_status, e.note, e.changed_at,
            u.full_name AS changed_by_name
       FROM retention_action_events e
       LEFT JOIN users u ON u.id = e.changed_by
      WHERE e.action_id = $1
      ORDER BY e.changed_at DESC`,
    [actionId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    changedByName: row.changed_by_name,
    changedAt: row.changed_at,
  }));
}

export interface CreateActionInput {
  customerId: string;
  strategyId?: string | null;
  predictionId?: string | null;
  title: string;
  description?: string | null;
  priority?: string;
  assignedTo?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  /** From the suggestion flow, so the action records its origin. */
  suggestedIntervention?: string | null;
}

export async function createAction(
  input: CreateActionInput,
): Promise<ActionSummary> {
  const actor = await requireCapability("createActions");
  if (!isUuid(input.customerId)) {
    throw AppError.notFound("That customer does not exist.");
  }
  const title = input.title.trim();
  if (title.length < 3) {
    throw AppError.unprocessable("Give the action a title of at least 3 characters.", {
      fields: { title: "Give the action a title of at least 3 characters." },
    });
  }
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw AppError.unprocessable("Enter the follow-up date as YYYY-MM-DD.", {
      fields: { dueDate: "Use the date picker." },
    });
  }
  if (input.assignedTo && !isUuid(input.assignedTo)) {
    throw AppError.unprocessable("That is not a valid assignee.", {
      fields: { assignedTo: "Choose someone from the list." },
    });
  }

  const db = await getDatabase();
  const customer = await db.query<{
    id: string;
    latest_prediction_id: string | null;
    churn_probability: string | null;
  }>(
    `SELECT c.id, c.latest_prediction_id, p.churn_probability
       FROM customers c
       LEFT JOIN predictions p ON p.id = c.latest_prediction_id
      WHERE c.id = $1`,
    [input.customerId],
  );
  if (!customer.rows[0]) throw AppError.notFound("That customer does not exist.");
  const record = customer.rows[0];

  const predictionId = input.predictionId ?? record.latest_prediction_id;

  const result = await db.query<{ id: string }>(
    `INSERT INTO customer_retention_actions
       (customer_id, prediction_id, strategy_id, title, description, status,
        priority, assigned_to, due_date, notes,
        churn_probability_at_creation, created_by)
     VALUES ($1,$2,$3,$4,$5,'suggested',$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      input.customerId,
      predictionId,
      input.strategyId ?? null,
      title,
      input.description ?? input.suggestedIntervention ?? null,
      input.priority ?? "medium",
      input.assignedTo ?? null,
      input.dueDate ?? null,
      input.notes ?? null,
      record.churn_probability,
      actor.id,
    ],
  );

  const actionId = result.rows[0].id;
  // The first event is written explicitly, because there is no previous status
  // to change from and the timeline should still start at creation.
  await db.query(
    `INSERT INTO retention_action_events (action_id, from_status, to_status, note, changed_by)
     VALUES ($1, NULL, 'suggested', $2, $3)`,
    [actionId, "Action created", actor.id],
  );

  await recordAudit({
    action: AUDIT.actionCreated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "retention_action",
    resourceId: actionId,
    metadata: {
      customerId: input.customerId,
      strategyId: input.strategyId ?? null,
      priority: input.priority ?? "medium",
      dueDate: input.dueDate ?? null,
    },
  });

  const created = await getAction(actionId);
  if (!created) throw AppError.internal("The action could not be read back.");
  return created;
}

export interface UpdateActionInput {
  title?: string;
  description?: string | null;
  priority?: string;
  assignedTo?: string | null;
  dueDate?: string | null;
  notes?: string | null;
}

export async function updateAction(
  actionId: string,
  input: UpdateActionInput,
): Promise<ActionSummary> {
  const actor = await requireCapability("createActions");
  if (!isUuid(actionId)) throw AppError.notFound("That action does not exist.");

  const db = await getDatabase();
  const existing = await db.query<{ status: ActionStatus }>(
    "SELECT status FROM customer_retention_actions WHERE id = $1",
    [actionId],
  );
  if (!existing.rows[0]) throw AppError.notFound("That action does not exist.");
  if (
    existing.rows[0].status === "completed" ||
    existing.rows[0].status === "cancelled"
  ) {
    throw AppError.conflict(
      `This action is already ${existing.rows[0].status} and cannot be edited.`,
      "Create a new action if more work is needed.",
    );
  }

  const result = await db.query(
    `UPDATE customer_retention_actions
        SET title = COALESCE($2, title),
            description = COALESCE($3, description),
            priority = COALESCE($4, priority),
            assigned_to = COALESCE($5, assigned_to),
            due_date = COALESCE($6, due_date),
            notes = COALESCE($7, notes)
      WHERE id = $1 RETURNING id`,
    [
      actionId,
      input.title?.trim() ?? null,
      input.description ?? null,
      input.priority ?? null,
      input.assignedTo ?? null,
      input.dueDate ?? null,
      input.notes ?? null,
    ],
  );
  if (!result.rows.length) throw AppError.notFound("That action does not exist.");

  await recordAudit({
    action: AUDIT.actionUpdated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "retention_action",
    resourceId: actionId,
    metadata: { fields: Object.keys(input) },
  });
  const updated = await getAction(actionId);
  if (!updated) throw AppError.internal("The action could not be read back.");
  return updated;
}

/**
 * Move an action to a new status.
 *
 * Only transitions the workflow defines are accepted, and the history row is
 * written in the same transaction as the change, so the timeline cannot drift
 * from the current status.
 */
export async function changeActionStatus(
  actionId: string,
  nextStatus: ActionStatus,
  note?: string,
): Promise<ActionSummary> {
  const actor = await requireCapability("createActions");
  if (!isUuid(actionId)) throw AppError.notFound("That action does not exist.");

  const db = await getDatabase();
  const existing = await db.query<{ status: ActionStatus; customer_id: string }>(
    "SELECT status, customer_id FROM customer_retention_actions WHERE id = $1",
    [actionId],
  );
  const current = existing.rows[0];
  if (!current) throw AppError.notFound("That action does not exist.");

  if (current.status === nextStatus) {
    throw AppError.conflict(
      `This action is already ${ACTION_STATUS_LABELS[nextStatus].toLowerCase()}.`,
    );
  }
  const allowed = ACTION_TRANSITIONS[current.status];
  if (!allowed.includes(nextStatus)) {
    throw AppError.unprocessable(
      `An action that is ${ACTION_STATUS_LABELS[current.status].toLowerCase()} ` +
        `cannot move to ${ACTION_STATUS_LABELS[nextStatus].toLowerCase()}.`,
      {
        fields: {
          status:
            allowed.length > 0
              ? `Allowed next: ${allowed
                  .map((status) => ACTION_STATUS_LABELS[status])
                  .join(", ")}.`
              : "This action is closed and cannot change status.",
        },
      },
    );
  }

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE customer_retention_actions
          SET status = $2,
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END
        WHERE id = $1`,
      [actionId, nextStatus],
    );
    await tx.query(
      `INSERT INTO retention_action_events
         (action_id, from_status, to_status, note, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [actionId, current.status, nextStatus, note ?? null, actor.id],
    );
  });

  await recordAudit({
    action: AUDIT.actionStatusChanged,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "retention_action",
    resourceId: actionId,
    metadata: { from: current.status, to: nextStatus },
  });

  const updated = await getAction(actionId);
  if (!updated) throw AppError.internal("The action could not be read back.");
  return updated;
}

/** Counts for the retention overview, computed from stored rows. */
export async function getRetentionSummary(): Promise<{
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  open: number;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  completed: number;
  total: number;
}> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<{
    by_status: Record<string, number>;
    by_priority: Record<string, number>;
    open: string;
    overdue: string;
    due_soon: string;
    unassigned: string;
    completed: string;
    total: string;
  }>(
    `SELECT
       (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM
          (SELECT status, count(*) AS n FROM customer_retention_actions
            GROUP BY status) s) AS by_status,
       (SELECT coalesce(jsonb_object_agg(priority, n), '{}'::jsonb) FROM
          (SELECT priority, count(*) AS n FROM customer_retention_actions
            GROUP BY priority) p) AS by_priority,
       (SELECT count(*) FROM customer_retention_actions
         WHERE status NOT IN ('completed','cancelled')) AS open,
       (SELECT count(*) FROM customer_retention_actions
         WHERE due_date < current_date
           AND status NOT IN ('completed','cancelled')) AS overdue,
       (SELECT count(*) FROM customer_retention_actions
         WHERE due_date >= current_date AND due_date <= current_date + 7
           AND status NOT IN ('completed','cancelled')) AS due_soon,
       (SELECT count(*) FROM customer_retention_actions
         WHERE assigned_to IS NULL
           AND status NOT IN ('completed','cancelled')) AS unassigned,
       (SELECT count(*) FROM customer_retention_actions
         WHERE status = 'completed') AS completed,
       (SELECT count(*) FROM customer_retention_actions) AS total`,
  );
  const row = result.rows[0];
  return {
    byStatus: row.by_status ?? {},
    byPriority: row.by_priority ?? {},
    open: Number(row.open),
    overdue: Number(row.overdue),
    dueSoon: Number(row.due_soon),
    unassigned: Number(row.unassigned),
    completed: Number(row.completed),
    total: Number(row.total),
  };
}
