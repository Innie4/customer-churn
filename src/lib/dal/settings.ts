/**
 * Platform settings.
 *
 * Small, attributable, operator-editable values. The risk thresholds live here
 * rather than in code so they can be changed without a deploy, and every change
 * is audited.
 */

import "server-only";

import { getDatabase } from "../../../db/client";
import { AppError } from "../api";
import { AUDIT, recordAudit } from "../audit";
import { requireActor, requireCapability } from "./access";

export interface RiskThresholds {
  high: number;
  medium: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = { high: 0.7, medium: 0.4 };

export async function getRiskThresholds(): Promise<RiskThresholds> {
  const db = await getDatabase();
  const result = await db.query<{ value: unknown }>(
    "SELECT value FROM app_settings WHERE key = 'risk.thresholds'",
  );
  const value = result.rows[0]?.value as Partial<RiskThresholds> | undefined;
  if (!value || typeof value.high !== "number" || typeof value.medium !== "number") {
    return DEFAULT_RISK_THRESHOLDS;
  }
  return { high: value.high, medium: value.medium };
}

export async function updateRiskThresholds(
  input: RiskThresholds,
): Promise<RiskThresholds> {
  const actor = await requireCapability("manageModels");
  if (
    !Number.isFinite(input.high) ||
    !Number.isFinite(input.medium) ||
    input.high <= 0 ||
    input.high >= 1 ||
    input.medium <= 0 ||
    input.medium >= 1
  ) {
    throw AppError.unprocessable(
      "Both thresholds must be between 0 and 1.",
      { fields: { thresholds: "Enter two values between 0 and 1." } },
    );
  }
  if (input.medium >= input.high) {
    throw AppError.unprocessable(
      "The medium threshold must be lower than the high threshold.",
      {
        fields: {
          medium: "Must be lower than the high threshold.",
        },
      },
    );
  }

  const db = await getDatabase();
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ('risk.thresholds', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(input), actor.id],
  );

  await recordAudit({
    action: AUDIT.settingUpdated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "setting",
    resourceId: "risk.thresholds",
    metadata: { before: undefined, after: input },
  });

  return input;
}

export interface MlSettings {
  cvFolds: number;
  randomSeed: number;
  smoteEnabled: boolean;
  testSize: number;
  defaultModelTypes: string[];
}

export async function getMlSettings(): Promise<MlSettings> {
  const db = await getDatabase();
  const result = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings
      WHERE key IN ('ml.cv_folds','ml.random_seed','ml.smote_enabled',
                    'ml.test_size','ml.default_model_types')`,
  );
  const byKey = new Map(result.rows.map((row) => [row.key, row.value]));
  return {
    cvFolds: Number(byKey.get("ml.cv_folds") ?? 5),
    randomSeed: Number(byKey.get("ml.random_seed") ?? 42),
    smoteEnabled: byKey.get("ml.smote_enabled") !== false,
    testSize: Number(byKey.get("ml.test_size") ?? 0.2),
    defaultModelTypes: Array.isArray(byKey.get("ml.default_model_types"))
      ? (byKey.get("ml.default_model_types") as string[])
      : ["logistic_regression", "random_forest", "xgboost"],
  };
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await getDatabase();
  const result = await db.query<{ value: T }>(
    "SELECT value FROM app_settings WHERE key = $1",
    [key],
  );
  return result.rows[0]?.value ?? fallback;
}

export async function listSettings(): Promise<
  { key: string; value: unknown; updatedAt: string; updatedByName: string | null }[]
> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<{
    key: string;
    value: unknown;
    updated_at: string;
    updated_by_name: string | null;
  }>(
    `SELECT s.key, s.value, s.updated_at, u.full_name AS updated_by_name
       FROM app_settings s
       LEFT JOIN users u ON u.id = s.updated_by
      ORDER BY s.key`,
  );
  return result.rows.map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  }));
}
