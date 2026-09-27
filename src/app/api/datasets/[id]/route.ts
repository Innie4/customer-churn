/**
 * GET /api/datasets/[id]
 *
 * One dataset with its columns, validation verdict and preprocessing history.
 */

import { AppError } from "@/lib/api";
import { getDataset, getDatasetValidation, softDeleteDataset } from "@/lib/dal/datasets";
import { AUDIT } from "@/lib/audit";
import { endpoint } from "@/lib/route";

export const GET = endpoint("datasets.get", {}, async (context) => {
  const { id } = await context.params;
  const dataset = await getDataset(id);
  if (!dataset) {
    throw AppError.notFound(
      "That dataset does not exist, or it has been deleted.",
      "Go back to the dataset list and choose another.",
    );
  }
  const validation = await getDatasetValidation(id);
  return { dataset, validation };
});

export const DELETE = endpoint(
  "datasets.delete",
  { capability: "manageModels", auditAction: AUDIT.datasetDeleted },
  async (context) => {
    const { id } = await context.params;
    await softDeleteDataset(id);
    return { ok: true };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
