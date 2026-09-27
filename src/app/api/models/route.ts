/**
 * GET /api/models
 *
 * The model history. Every trained model is listed, including the ones that
 * failed, because a model history that hides failures is not a history.
 */

import { MODEL_TYPE_LABELS, MODEL_TYPE_NOTES, listModels } from "@/lib/dal/models";
import { endpoint, queryParam } from "@/lib/route";

export const GET = endpoint("models.list", {}, async (context) => {
  const modelType = queryParam(context.request, "modelType");
  const onlyActive = queryParam(context.request, "active") === "true";
  const models = await listModels({
    onlyActive,
    modelType:
      modelType === "logistic_regression" ||
      modelType === "random_forest" ||
      modelType === "xgboost"
        ? modelType
        : undefined,
  });
  return {
    models,
    count: models.length,
    families: Object.entries(MODEL_TYPE_LABELS).map(([type, label]) => ({
      type,
      label,
      note: MODEL_TYPE_NOTES[type as keyof typeof MODEL_TYPE_NOTES],
    })),
  };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
