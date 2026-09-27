/**
 * GET /api/models/[id]/performance
 *
 * Measured performance for one model, with validation and test figures kept
 * apart. Blending them would hide the effect of resampling on the validation
 * numbers, which is one of the more interesting results in the study.
 */

import { AppError } from "@/lib/api";
import { getModel } from "@/lib/dal/models";
import { endpoint } from "@/lib/route";

export const GET = endpoint("models.performance", {}, async (context) => {
  const { id } = await context.params;
  const model = await getModel(id);
  if (!model) {
    throw AppError.notFound(
      "That model does not exist.",
      "Go back to the model history and choose another model.",
    );
  }
  if (model.status !== "completed") {
    throw AppError.unprocessable(
      "This model did not finish training, so it has no performance figures.",
      {
        nextAction: model.error
          ? `Training failed: ${model.error}`
          : "Wait for training to finish, or train a new model.",
      },
    );
  }

  return {
    modelId: model.id,
    modelType: model.modelType,
    displayName: model.displayName,
    version: model.version,
    isActive: model.isActive,
    validation: {
      metrics: model.validationMetrics,
      confusion: model.validationConfusion,
      notes: model.validationNotes,
      source:
        "Out-of-fold predictions on the training split. Because that split " +
        "was SMOTE-balanced, these figures run higher than the test figures.",
    },
    test: {
      metrics: model.testMetrics,
      confusion: model.testConfusion,
      roc: model.testRoc,
      decileLift: model.decileLift,
      notes: model.testNotes,
      source:
        "Measured once, on the held-out test split, which was never used " +
        "for tuning or resampling.",
    },
    gridSearch: model.gridSearch,
    hyperparameters: model.hyperparameters,
    featureCount: model.featureCount,
    trainDurationSeconds: model.trainDurationSeconds,
    caveat:
      "These figures describe model performance on a sample. They do not " +
      "establish that a retention intervention built on them will succeed.",
  };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
