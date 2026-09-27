/**
 * POST /api/datasets/[id]/validate
 *
 * Re-reads the stored file and re-runs inspection. Safe to call repeatedly: the
 * latest verdict replaces the previous one, and only the current state of a
 * file matters.
 */

import { AppError } from "@/lib/api";
import { revalidateDataset } from "@/lib/dal/datasets";
import { endpoint } from "@/lib/route";

export const POST = endpoint("datasets.validate", {}, async (context) => {
  const { id } = await context.params;
  let inspection;
  try {
    inspection = await revalidateDataset(id);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.internal("Validation could not be completed.");
  }
  return {
    inspection,
    status: inspection.issues.some((issue) => issue.severity === "error")
      ? "fail"
      : "pass",
    errors: inspection.issues.filter((issue) => issue.severity === "error"),
    warnings: inspection.issues.filter((issue) => issue.severity === "warning"),
    notes: inspection.issues.filter((issue) => issue.severity === "info"),
  };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
