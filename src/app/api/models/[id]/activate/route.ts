/**
 * POST /api/models/[id]/activate
 *
 * Make a trained model the one that serves predictions.
 *
 * There is no automatic "best model" promotion. A person chooses, states why,
 * and the choice is recorded with their name and the time.
 */

import { z } from "zod";
import { AUDIT } from "@/lib/audit";
import { activateModel, deactivateModel } from "@/lib/dal/models";
import { body, endpoint } from "@/lib/route";
const ActivateSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason for activating this model.")
    .max(1000),
});

export const POST = endpoint(
  "models.activate",
  {
    capability: "activateModels",
    auditAction: AUDIT.modelActivated,
    auditResource: (result) => {
      const model = result as { id?: string; modelType?: string; isActive?: boolean };
      return model.id
        ? {
            resourceType: "model",
            resourceId: model.id,
            metadata: { modelType: model.modelType, isActive: model.isActive },
          }
        : null;
    },
  },
  async (context) => {
    const { id } = await context.params;
    const { reason } = await body(context.request, ActivateSchema);
    return activateModel(id, reason);
  },
);

/** DELETE deactivates, so a model can be taken out of service deliberately. */
export const DELETE = endpoint(
  "models.deactivate",
  {
    capability: "activateModels",
    auditAction: AUDIT.modelDeactivated,
  },
  async (context) => {
    const { id } = await context.params;
    await deactivateModel(id);
    return { ok: true, id };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
