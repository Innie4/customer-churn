/**
 * GET and POST /api/datasets/[id]/customers
 *
 * GET lists the customer rows loaded for a dataset. POST loads them in the
 * first place, which happens after preprocessing because the identifier and
 * target columns are only settled by then.
 */

import { AppError } from "@/lib/api";
import { latestPreprocessingRun, loadCustomers } from "@/lib/dal/datasets";
import { listCustomers } from "@/lib/dal/customers";
import { body, endpoint, queryInt } from "@/lib/route";
import { z } from "zod";

/**
 * The customers loaded for a dataset.
 *
 * Readable by any signed-in account. Paged, because a real dataset has
 * thousands of rows and returning all of them would be a denial of service
 * dressed up as convenience.
 */
export const GET = endpoint(
  "datasets.customers",
  {},
  async (context) => {
    const { id } = await context.params;
    const page = await listCustomers({
      datasetId: id,
      page: queryInt(context.request, "page", 1),
      pageSize: queryInt(context.request, "pageSize", 50),
    });
    return page;
  },
);

const LoadSchema = z.object({
  /** Overrides the columns recorded at preprocessing time. */
  targetColumn: z.string().min(1).max(200).optional(),
  idColumns: z.array(z.string().min(1).max(200)).max(5).optional(),
});

export const POST = endpoint(
  "datasets.load_customers",
  { capability: "manageModels" },
  async (context) => {
    const { id } = await context.params;
    // Both fields are optional, so an empty body is valid and means "use what
    // preprocessing recorded".
    const options = await body(context.request, LoadSchema).catch(
      (): z.infer<typeof LoadSchema> => ({}),
    );

    // The most recent completed run is the right one to load from, unless the
    // caller names different columns.
    const run = options.targetColumn
      ? null
      : await latestPreprocessingRun(id);
    if (!options.targetColumn && !run) {
      throw AppError.unprocessable(
        "This dataset has no completed preprocessing run.",
        { nextAction: "Run preprocessing first, then load customers." },
      );
    }

    const params = (run?.params ?? {}) as {
      target_column?: string;
      id_columns?: string[];
    };
    const targetColumn = options.targetColumn ?? params.target_column;
    if (!targetColumn) {
      throw AppError.unprocessable(
        "No target column is known for this dataset.",
        { nextAction: "Run preprocessing, or supply the target column." },
      );
    }

    return loadCustomers(id, {
      targetColumn,
      idColumns: options.idColumns ?? params.id_columns ?? [],
    });
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
