"use server";

/**
 * Server actions for the data and model pipeline.
 *
 * These wrap the same data access functions the API routes call, so there is
 * one implementation of each behaviour. Each action re-resolves the session and
 * capability itself, because a page-level check does not extend to an action.
 *
 * Every action returns a plain result instead of throwing, so a form can render
 * the failure next to the control that caused it.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/api";
import { currentActor, assertCan, type Capability } from "@/lib/dal/access";
import {
  formatBytes,
  getDataset,
  isUuid,
  loadCustomers,
  preprocessDataset,
  revalidateDataset,
  softDeleteDataset,
  uploadDataset,
} from "@/lib/dal/datasets";
import {
  activateModel,
  deactivateModel,
  flagRisk,
  resolveRiskReview,
  startTraining,
  syncModelRun,
  type ModelType,
} from "@/lib/dal/models";
import { explainCustomer, generateGlobalExplanation } from "@/lib/dal/customers";
import { env } from "@/lib/env";

export interface ActionResult {
  ok: boolean;
  message?: string;
  fields?: Record<string, string>;
  /** Where to send the operator once the action succeeds. */
  redirectTo?: string;
}

function failure(error: unknown, fallbackFields?: Record<string, string>): ActionResult {
  if (error instanceof AppError) {
    return {
      ok: false,
      message: `${error.message}${error.nextAction ? ` ${error.nextAction}` : ""}`,
      fields: error.fields ?? fallbackFields,
    };
  }
  console.error("[action] unexpected failure", error);
  return {
    ok: false,
    message:
      "Something went wrong while processing that. Try again, and check the " +
      "server log if it keeps happening.",
  };
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export async function uploadDatasetAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    assertCan(await currentActor(), "upload");
    actor = await currentActor();
  } catch (error) {
    return failure(error);
  }
  if (!actor) return { ok: false, message: "You need to sign in to upload data." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      message: "Choose a CSV file to upload.",
      fields: { file: "Choose a file that contains data." },
    };
  }

  const name = String(formData.get("name") ?? "").trim();
  const targetColumn = String(formData.get("targetColumn") ?? "").trim();
  const idColumns = String(formData.get("idColumns") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (file.size > env.maxUploadBytes) {
    return {
      ok: false,
      message: `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(
        env.maxUploadBytes,
      )}.`,
      fields: { file: "Choose a smaller file." },
    };
  }

  try {
    const result = await uploadDataset({
      file: {
        filename: file.name || "upload.csv",
        buffer: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "text/csv",
      },
      actor,
      name: name || undefined,
      targetColumn: targetColumn || undefined,
      idColumns: idColumns.length ? idColumns.slice(0, 5) : undefined,
    });

    revalidatePath("/datasets");
    const errors = result.inspection.issues.filter(
      (issue) => issue.severity === "error",
    );
    if (errors.length > 0) {
      // The dataset was stored, so the operator is sent to its page to read
      // what is wrong rather than back to an empty form.
      return {
        ok: true,
        message: `Uploaded, but ${errors.length} problem${
          errors.length === 1 ? "" : "s"
        } must be fixed before it can be used: ${errors
          .map((issue) => issue.message)
          .join("; ")}`,
        redirectTo: `/datasets/${result.dataset.id}/validation`,
      };
    }
    return {
      ok: true,
      message: `Uploaded. ${result.dataset.rowCount?.toLocaleString() ?? 0} rows, ${
        result.dataset.columnCount ?? 0
      } columns, all checks passed.`,
      redirectTo: `/datasets/${result.dataset.id}`,
    };
  } catch (error) {
    return failure(error, { file: "That file could not be accepted." });
  }
}

export async function revalidateDatasetAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = String(formData.get("datasetId") ?? "");
  if (!isUuid(id)) return { ok: false, message: "That dataset id is not valid." };
  try {
    const inspection = await revalidateDataset(id);
    revalidatePath(`/datasets/${id}`);
    const errors = inspection.issues.filter((issue) => issue.severity === "error");
    return {
      ok: errors.length === 0,
      message:
        errors.length === 0
          ? `Validation passed. ${inspection.issues.filter((i) => i.severity === "warning").length} warning(s) recorded.`
          : `Validation found ${errors.length} problem(s) that must be fixed: ${errors
              .map((issue) => issue.message)
              .join("; ")}`,
      redirectTo: `/datasets/${id}/validation`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function preprocessDatasetAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = String(formData.get("datasetId") ?? "");
  if (!isUuid(id)) return { ok: false, message: "That dataset id is not valid." };

  const testSizeRaw = String(formData.get("testSize") ?? "0.2");
  const testSize = Number.parseFloat(testSizeRaw);
  if (!Number.isFinite(testSize) || testSize <= 0 || testSize >= 0.9) {
    return {
      ok: false,
      message: "Choose a test share between 0.05 and 0.5.",
      fields: { testSize: "Use a value between 0.05 and 0.5." },
    };
  }

  const idColumns = String(formData.get("idColumns") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const targetColumn = String(formData.get("targetColumn") ?? "").trim();

  try {
    const { result } = await preprocessDataset(id, {
      testSize,
      stratify: formData.get("stratify") === "on" || formData.get("stratify") === "true",
      applySmote: formData.get("applySmote") === "on" || formData.get("applySmote") === "true",
      idColumns: idColumns.length ? idColumns.slice(0, 5) : undefined,
      targetColumn: targetColumn || undefined,
    });

    // Customers are loaded in the same action, because a trained model is
    // useless without customers to score.
    let customersMessage = "";
    try {
      const counts = await loadCustomers(id, {
        targetColumn: result.target_column,
        idColumns: idColumns.slice(0, 5),
      });
      const warnings = counts.warnings.length ? ` ${counts.warnings.join(" ")}` : "";
      customersMessage = ` ${counts.inserted.toLocaleString()} customer(s) loaded.${warnings}`;
    } catch (loadError) {
      // Preprocessing succeeded, so report the load separately rather than
      // presenting the whole run as a failure.
      customersMessage = ` Customers could not be loaded: ${
        loadError instanceof Error ? loadError.message : "unknown error"
      }`;
    }

    revalidatePath(`/datasets/${id}`);
    return {
      ok: true,
      message: `Preprocessing complete. ${result.split.train_rows.toLocaleString()} training rows, ${result.split.test_rows.toLocaleString()} test rows, ${result.encoded_feature_count} encoded features.${customersMessage}`,
      redirectTo: `/datasets/${id}/preprocessing`,
    };
  } catch (error) {
    revalidatePath(`/datasets/${id}`);
    return failure(error);
  }
}

export async function deleteDatasetAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("datasetId") ?? "");
  if (!isUuid(id)) return { ok: false, message: "That dataset id is not valid." };
  try {
    assertCan(await currentActor(), "manageModels");
    await softDeleteDataset(id);
    revalidatePath("/datasets");
    return { ok: true, message: "Dataset deleted.", redirectTo: "/datasets" };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

const MODEL_TYPES: ModelType[] = [
  "logistic_regression",
  "random_forest",
  "xgboost",
];

export async function startTrainingAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const datasetId = String(formData.get("datasetId") ?? "");
  const preprocessingRunId = String(formData.get("preprocessingRunId") ?? "");
  const selected = formData.getAll("modelTypes").map(String);
  const modelTypes = MODEL_TYPES.filter((type) => selected.includes(type));
  const cvFolds = Number.parseInt(String(formData.get("cvFolds") ?? "5"), 10);
  const randomSeed = Number.parseInt(String(formData.get("randomSeed") ?? "42"), 10);
  const label = String(formData.get("label") ?? "").trim();

  const fields: Record<string, string> = {};
  if (!isUuid(datasetId)) fields.datasetId = "Choose a dataset.";
  if (!isUuid(preprocessingRunId)) {
    fields.preprocessingRunId =
      "Run preprocessing on this dataset first. Training needs a completed preprocessing run.";
  }
  if (modelTypes.length === 0) {
    fields.modelTypes = "Choose at least one model to train.";
  }
  if (!Number.isFinite(cvFolds) || cvFolds < 2 || cvFolds > 10) {
    fields.cvFolds = "Use between 2 and 10 folds.";
  }
  if (Object.keys(fields).length > 0) return { ok: false, message: "Check the highlighted fields.", fields };

  try {
    const run = await startTraining({
      datasetId,
      preprocessingRunId,
      modelTypes,
      cvFolds,
      randomSeed,
      label: label || undefined,
    });
    revalidatePath("/training");
    return {
      ok: true,
      message: "Training started. This page will follow its progress.",
      redirectTo: `/training/${run.id}`,
    };
  } catch (error) {
    return failure(error);
  }
}

/** Poll a run from the training page. */
export async function refreshTrainingRunAction(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("runId") ?? "");
  if (!isUuid(id)) return { ok: false, message: "That run id is not valid." };
  try {
    const run = await syncModelRun(id);
    revalidatePath(`/training/${id}`);
    return { ok: true, message: `Run status: ${run.status}.` };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export async function activateModelAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const modelId = String(formData.get("modelId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(modelId)) return { ok: false, message: "That model id is not valid." };
  if (reason.length < 3) {
    return {
      ok: false,
      message: "Give a short reason for activating this model.",
      fields: {
        reason:
          "Explain in a few words why this model should serve predictions. " +
          "It is recorded in the audit trail.",
      },
    };
  }
  try {
    const model = await activateModel(modelId, reason);
    revalidatePath("/models");
    revalidatePath(`/models/${modelId}`);
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: `${model.displayName} is now active for predictions.`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function deactivateModelAction(formData: FormData): Promise<ActionResult> {
  const modelId = String(formData.get("modelId") ?? "");
  if (!isUuid(modelId)) return { ok: false, message: "That model id is not valid." };
  try {
    await deactivateModel(modelId);
    revalidatePath("/models");
    revalidatePath(`/models/${modelId}`);
    revalidatePath("/dashboard");
    return { ok: true, message: "That model is no longer active." };
  } catch (error) {
    return failure(error);
  }
}

export async function flagRiskAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const modelId = String(formData.get("modelId") ?? "");
  const feature = String(formData.get("feature") ?? "").trim();
  const concernType = String(formData.get("concernType") ?? "needs_review");
  const severity = String(formData.get("severity") ?? "medium");
  const notes = String(formData.get("notes") ?? "").trim();

  if (!isUuid(modelId)) return { ok: false, message: "That model id is not valid." };
  if (feature.length < 2) {
    return { ok: false, message: "Name the feature you are flagging.", fields: { feature: "Required." } };
  }
  if (
    !["proxy_risk", "questionable_variable", "bias_concern", "needs_review"].includes(
      concernType,
    )
  ) {
    return { ok: false, message: "Choose a concern type." };
  }
  if (!["low", "medium", "high"].includes(severity)) {
    return { ok: false, message: "Choose a severity." };
  }

  try {
    await flagRisk(modelId, {
      feature,
      concernType: concernType as
        | "proxy_risk"
        | "questionable_variable"
        | "bias_concern"
        | "needs_review",
      severity: severity as "low" | "medium" | "high",
      notes: notes || null,
    });
    revalidatePath(`/models/${modelId}`);
    return { ok: true, message: "The feature has been flagged for review." };
  } catch (error) {
    return failure(error);
  }
}

export async function resolveRiskReviewAction(
  formData: FormData,
): Promise<ActionResult> {
  const reviewId = String(formData.get("reviewId") ?? "");
  const modelId = String(formData.get("modelId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!isUuid(reviewId) || !isUuid(modelId)) {
    return { ok: false, message: "That review id is not valid." };
  }
  if (!["under_review", "accepted", "rejected", "mitigated"].includes(status)) {
    return { ok: false, message: "Choose a review outcome." };
  }
  try {
    await resolveRiskReview(reviewId, {
      status: status as "under_review" | "accepted" | "rejected" | "mitigated",
    });
    revalidatePath(`/models/${modelId}`);
    return { ok: true, message: "Review outcome recorded." };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Predictions and explanations
// ---------------------------------------------------------------------------

export async function generatePredictionsAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const modelId = String(formData.get("modelId") ?? "");
  if (!isUuid(modelId)) {
    return { ok: false, message: "Choose a model to score with." };
  }
  const highRaw = String(formData.get("highThreshold") ?? "");
  const mediumRaw = String(formData.get("mediumThreshold") ?? "");
  const high = highRaw ? Number.parseFloat(highRaw) : undefined;
  const medium = mediumRaw ? Number.parseFloat(mediumRaw) : undefined;

  if (
    (high !== undefined && (!Number.isFinite(high) || high <= 0 || high >= 1)) ||
    (medium !== undefined && (!Number.isFinite(medium) || medium <= 0 || medium >= 1))
  ) {
    return {
      ok: false,
      message: "Thresholds must be between 0 and 1.",
      fields: { thresholds: "Use values between 0 and 1." },
    };
  }
  if (high !== undefined && medium !== undefined && medium >= high) {
    return {
      ok: false,
      message: "The medium threshold must be lower than the high threshold.",
      fields: { mediumThreshold: "Must be lower than the high threshold." },
    };
  }

  try {
    const result = await (
      await import("@/lib/dal/customers")
    ).generatePredictions({ modelId, highThreshold: high, mediumThreshold: medium });

    revalidatePath("/predictions");
    revalidatePath("/customers");
    revalidatePath("/dashboard");

    const warnings = result.warnings.length
      ? ` ${result.warnings.length} warning(s): ${result.warnings.join(" ")}`
      : "";
    return {
      ok: true,
      message:
        `Scored ${result.scored.toLocaleString()} customer(s) with ${result.modelName}. ` +
        `${result.riskCounts.high} high, ${result.riskCounts.medium} medium, ${result.riskCounts.low} low.${warnings}`,
      redirectTo: "/predictions",
    };
  } catch (error) {
    return failure(error);
  }
}

export async function explainCustomerAction(
  customerId: string,
): Promise<ActionResult> {
  if (!isUuid(customerId)) {
    return { ok: false, message: "That customer id is not valid." };
  }
  try {
    const explanation = await explainCustomer(customerId);
    revalidatePath(`/customers/${customerId}`);
    return {
      ok: true,
      message: `Explanation generated with ${explanation.contributions.length} factor(s).`,
    };
  } catch (error) {
    // The prediction is unaffected by an explanation failure, so say so.
    revalidatePath(`/customers/${customerId}`);
    return failure(error);
  }
}

export async function generateGlobalExplanationAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const modelId = String(formData.get("modelId") ?? "");
  if (!isUuid(modelId)) return { ok: false, message: "Choose a model." };
  const sampleRaw = String(formData.get("sampleSize") ?? "1000");
  const sampleSize = Number.parseInt(sampleRaw, 10);
  try {
    const explanation = await generateGlobalExplanation(modelId, {
      sampleSize:
        Number.isFinite(sampleSize) && sampleSize >= 50 && sampleSize <= 5000
          ? sampleSize
          : 1000,
    });
    revalidatePath(`/models/${modelId}/explanations`);
    return {
      ok: true,
      message: `Ranked ${explanation.features.length} features over ${explanation.sampleSize.toLocaleString()} customers.`,
    };
  } catch (error) {
    return failure(error);
  }
}

/** Capability check helper reused by the forms that render role-gated controls. */
export async function canPerform(capability: Capability): Promise<boolean> {
  const actor = await currentActor();
  if (!actor) return false;
  try {
    assertCan(actor, capability);
    return true;
  } catch {
    return false;
  }
}

/** Read a dataset for a form that needs its latest preprocessing run. */
export async function datasetForPreprocessing(datasetId: string) {
  if (!isUuid(datasetId)) return null;
  const { latestPreprocessingRun } = await import("@/lib/dal/datasets");
  const [dataset, run] = await Promise.all([
    getDataset(datasetId),
    latestPreprocessingRun(datasetId),
  ]);
  return { dataset, run };
}

/** Redirect helper that keeps the pattern in one place. */
export async function goTo(path: string): Promise<never> {
  redirect(path);
}
