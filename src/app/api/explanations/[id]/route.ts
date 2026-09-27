/**
 * GET /api/explanations/[id]
 *
 * One stored explanation. `id` is a prediction id, which is how a customer page
 * asks for the explanation of the prediction it is showing.
 */

import { AppError } from "@/lib/api";
import { getExplanationForPrediction } from "@/lib/dal/customers";
import { endpoint } from "@/lib/route";

export const GET = endpoint("explanations.get", {}, async (context) => {
  const { id } = await context.params;
  const explanation = await getExplanationForPrediction(id);
  if (!explanation) {
    throw AppError.notFound(
      "No explanation has been generated for this prediction yet.",
      "Generate the explanation from the customer page.",
    );
  }
  return { explanation };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
