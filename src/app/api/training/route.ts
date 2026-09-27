/**
 * POST /api/training
 *
 * Submit a training run. The run is queued on the machine learning service and
 * executed on a worker there, so this returns immediately with a run id to poll
 * rather than blocking until three grid searches finish.
 */

import { z } from "zod";
import { AUDIT } from "@/lib/audit";
import { startTraining } from "@/lib/dal/models";
import { body, endpoint } from "@/lib/route";

const StartTrainingSchema = z.object({
  datasetId: z.string().uuid("Choose a dataset."),
  preprocessingRunId: z.string().uuid("Run preprocessing first."),
  modelTypes: z
    .array(
      z.enum(["logistic_regression", "random_forest", "xgboost"], {
        message: "Unknown model type.",
      }),
    )
    .min(1, "Choose at least one model.")
    .max(3),
  cvFolds: z.number().int().min(2).max(10).optional(),
  randomSeed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  label: z.string().max(200).optional(),
});

export const POST = endpoint(
  "training.start",
  {
    capability: "manageModels",
    status: 202,
    auditAction: AUDIT.trainingStarted,
    auditResource: (result) => {
      const run = result as { id?: string; requestedModels?: string[] };
      return run.id
        ? {
            resourceType: "model_run",
            resourceId: run.id,
            metadata: { modelTypes: run.requestedModels },
          }
        : null;
    },
  },
  async (context) => {
    const input = await body(context.request, StartTrainingSchema);
    return startTraining({
      datasetId: input.datasetId,
      preprocessingRunId: input.preprocessingRunId,
      modelTypes: input.modelTypes,
      cvFolds: input.cvFolds ?? 5,
      randomSeed: input.randomSeed ?? 42,
      label: input.label,
    });
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
