/**
 * GET /api/models/[id]
 *
 * One model with its measured metrics, selected hyperparameters, artifacts and
 * model-risk review.
 */

import { AppError } from "@/lib/api";
import { MODEL_TYPE_LABELS, MODEL_TYPE_NOTES, getModel } from "@/lib/dal/models";
import { endpoint } from "@/lib/route";

export const GET = endpoint("models.get", {}, async (context) => {
  const { id } = await context.params;
  const model = await getModel(id);
  if (!model) {
    throw AppError.notFound(
      "That model does not exist.",
      "Go back to the model history and choose another model.",
    );
  }
  return {
    model,
    notes: MODEL_TYPE_NOTES[model.modelType],
    familyLabel: MODEL_TYPE_LABELS[model.modelType],
  };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
