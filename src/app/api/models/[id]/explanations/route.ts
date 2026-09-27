/**
 * GET and POST /api/models/[id]/explanations
 *
 * POST computes global SHAP feature importance across a sample of the model's
 * own customers and stores it. GET returns what was stored.
 *
 * Split rather than recomputed on read because a global explanation is a
 * measured result tied to a model version: recomputing it per view would make
 * the figures change under a reader comparing two models, and cost a full
 * SHAP pass for every page load.
 */

import { z } from "zod";
import {
  generateGlobalExplanation,
  getGlobalExplanation,
} from "@/lib/dal/customers";
import { body, endpoint } from "@/lib/route";

const GlobalExplanationSchema = z.object({
  sampleSize: z.number().int().min(50).max(5000).optional(),
});

/** The stored explanation, or null when none has been generated. */
export const GET = endpoint("models.explanations_global_read", {}, async (context) => {
  const { id } = await context.params;
  const explanation = await getGlobalExplanation(id);
  return { explanation };
});

export const POST = endpoint(
  "models.explanations_global",
  { capability: "manageModels" },
  async (context) => {
    const { id } = await context.params;
    const options = await body(context.request, GlobalExplanationSchema).catch(
      () => ({}),
    );
    return generateGlobalExplanation(id, options);
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
