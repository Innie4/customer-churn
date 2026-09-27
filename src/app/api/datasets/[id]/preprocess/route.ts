/**
 * POST /api/datasets/[id]/preprocess
 *
 * Runs the documented preprocessing workflow and records the run. Every setting
 * is optional and defaults to the methodology in the study, so the common case
 * is a request with no body.
 */

import { z } from "zod";
import { AppError } from "@/lib/api";
import { AUDIT } from "@/lib/audit";
import { preprocessDataset } from "@/lib/dal/datasets";
import { body, endpoint } from "@/lib/route";

const PreprocessSchema = z.object({
  targetColumn: z.string().min(1).max(200).optional(),
  idColumns: z.array(z.string().min(1).max(200)).max(5).optional(),
  testSize: z.number().gt(0).lt(0.9).optional(),
  stratify: z.boolean().optional(),
  applySmote: z.boolean().optional(),
  randomSeed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});

export const POST = endpoint(
  "datasets.preprocess",
  {
    capability: "manageModels",
    auditAction: AUDIT.datasetPreprocessed,
    auditResource: (result) => {
      const preprocessed = result as { run?: { id: string } };
      return preprocessed.run
        ? { resourceType: "preprocessing_run", resourceId: preprocessed.run.id }
        : null;
    },
  },
  async (context) => {
    const { id } = await context.params;
    // An empty body is valid and means "use the documented defaults".
    const hasBody = (context.request.headers.get("content-length") ?? "0") !== "0";
    const options = hasBody
      ? await body(context.request, PreprocessSchema)
      : {};

    if (options.testSize !== undefined && (options.testSize < 0.05 || options.testSize > 0.5)) {
      throw AppError.unprocessable(
        "The test share should be between 0.05 and 0.5.",
        { fields: { testSize: "Use a value between 0.05 and 0.5." } },
      );
    }

    const { run, result } = await preprocessDataset(id, options);
    return {
      run,
      steps: result.steps,
      split: result.split,
      resample: result.resample,
      encodedFeatureCount: result.encoded_feature_count,
      encodedFeatures: result.encoded_features,
      warnings: result.warnings,
      scalerMean: result.scaler_mean,
      scalerScale: result.scaler_scale,
    };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
