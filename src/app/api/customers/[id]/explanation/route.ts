/**
 * POST /api/customers/[id]/explanation
 *
 * Generate the SHAP explanation for one customer.
 *
 * A failure here is recorded on the explanation and the customer page still
 * shows the risk, so a SHAP problem never makes the customer page unusable.
 */

import { explainCustomer } from "@/lib/dal/customers";
import { endpoint, queryInt } from "@/lib/route";

export const POST = endpoint(
  "customers.explain",
  { capability: "manageModels" },
  async (context) => {
    const { id } = await context.params;
    const topN = queryInt(context.request, "topN", 5);
    return explainCustomer(id, { topN: Math.min(Math.max(topN, 1), 20) });
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
