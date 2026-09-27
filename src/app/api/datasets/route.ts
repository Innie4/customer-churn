/**
 * POST /api/datasets
 *
 * Upload a churn dataset. The file is validated before it is stored, then
 * inspected so the dataset never appears in the list with unknown structure.
 */

import { AUDIT } from "@/lib/audit";
import { listDatasets, uploadDataset } from "@/lib/dal/datasets";
import { endpoint, formDataFile } from "@/lib/route";
import { requireCapability } from "@/lib/dal/access";

/**
 * GET /api/datasets
 *
 * The datasets available to this account, most recent first.
 *
 * Readable by any signed-in account, including a viewer: a viewer who cannot
 * upload can still see what has been uploaded, which is the point of the role.
 */

export const GET = endpoint("datasets.list", {}, async () => {
  const datasets = await listDatasets();
  return { datasets, count: datasets.length };
});

export const POST = endpoint(
  "datasets.upload",
  {
    capability: "upload",
    auditAction: AUDIT.datasetUploaded,
    auditResource: (result) => {
      const uploaded = result as {
        dataset?: { id: string; name: string; rowCount: number | null };
      };
      return uploaded.dataset
        ? {
            resourceType: "dataset",
            resourceId: uploaded.dataset.id,
            metadata: { name: uploaded.dataset.name, rows: uploaded.dataset.rowCount },
          }
        : null;
    },
  },
  async (context) => {
    const actor = await requireCapability("upload");
    // The body can only be read once, so the form is parsed a single time and
    // both the file and the text fields are taken from it.
    const form = await context.request.formData();
    const file = await formDataFile(form);

    // Both spellings are accepted. This API is camelCase throughout while the
    // machine learning service's form fields are snake_case, and a caller who
    // sends the service's spelling would otherwise have their column choices
    // dropped without any error — which is how a dataset ends up keyed by row
    // order instead of by customer.
    const first = (...names: string[]): string | undefined => {
      for (const name of names) {
        const value = form.get(name);
        if (typeof value === "string" && value.trim()) return value;
      }
      return undefined;
    };

    const targetColumn = first("targetColumn", "target_column");
    const name = first("name");
    const rawIdColumns = first("idColumns", "id_columns");

    const result = await uploadDataset({
      file,
      actor,
      name: name?.trim() || undefined,
      targetColumn,
      idColumns: rawIdColumns
        ? rawIdColumns
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined,
    });

    return {
      dataset: result.dataset,
      inspection: result.inspection,
      blockingIssues: result.inspection.issues.filter((i) => i.severity === "error"),
    };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
