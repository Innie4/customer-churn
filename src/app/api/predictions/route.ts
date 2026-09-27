/**
 * GET and POST /api/predictions
 *
 * GET lists predictions, with filtering by risk band and model. POST scores
 * customers with a model that has been activated.
 */

import { z } from "zod";

import {
  generatePredictions,
  listPredictions,
  type GeneratePredictionsInput,
} from "@/lib/dal/customers";
import { AUDIT } from "@/lib/audit";
import { body, endpoint, queryInt, queryParam } from "@/lib/route";

export const GET = endpoint("predictions.list", {}, async (context) => {
  const risk = queryParam(context.request, "risk", "all");
  const modelId = queryParam(context.request, "modelId");
  const search = queryParam(context.request, "search");
  return listPredictions({
    risk:
      risk === "low" || risk === "medium" || risk === "high" ? risk : "all",
    modelId,
    search,
    page: queryInt(context.request, "page", 1),
    pageSize: queryInt(context.request, "pageSize", 25),
  });
});

const GenerateSchema = z.object({
  modelId: z.string().min(1, "A model is required."),
  customerIds: z
    .array(z.string().min(1))
    .max(10_000)
    .optional()
    .describe("Which customers to score. Defaults to the model's whole dataset."),
  highThreshold: z
    .number()
    .gt(0, "The high-risk threshold must be above zero.")
    .lt(1, "The high-risk threshold must be below one.")
    .optional(),
  mediumThreshold: z
    .number()
    .gt(0, "The medium-risk threshold must be above zero.")
    .lt(1, "The medium-risk threshold must be below one.")
    .optional(),
});

/**
 * Score customers with an activated model.
 *
 * Requires the `manageModels` capability, because scoring writes a new set of
 * predictions that the rest of the platform then reasons about. The
 * authorisation check lives in the data access layer, not here, so it cannot be
 * bypassed by calling this route from somewhere else.
 */
export const POST = endpoint(
  "predictions.generate",
  {
    capability: "manageModels",
    auditAction: AUDIT.predictionsGenerated,
  },
  async (context) => {
    const input = await body(context.request, GenerateSchema);
    const result = await generatePredictions(input as GeneratePredictionsInput);
    return {
      ...result,
      predictions: result.predictions ?? [],
    };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
