/**
 * GET /api/predictions/[id]
 *
 * One prediction with its explanation, when one has been generated.
 */

import { AppError } from "@/lib/api";
import { getExplanationForPrediction, getPrediction } from "@/lib/dal/customers";
import { endpoint } from "@/lib/route";

export const GET = endpoint("predictions.get", {}, async (context) => {
  const { id } = await context.params;
  const prediction = await getPrediction(id);
  if (!prediction) {
    throw AppError.notFound(
      "That prediction does not exist.",
      "Go back to the prediction list and choose another.",
    );
  }
  const explanation = await getExplanationForPrediction(id);
  return { prediction, explanation };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
