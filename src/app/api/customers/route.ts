/**
 * GET /api/customers
 *
 * The customer list, with search, filtering, sorting and pagination.
 */

import { listCustomers } from "@/lib/dal/customers";
import { endpoint, queryInt, queryParam } from "@/lib/route";

const SORTS = new Set(["risk", "name", "recent", "probability"]);

export const GET = endpoint("customers.list", {}, async (context) => {
  const risk = queryParam(context.request, "risk", "all");
  const sort = queryParam(context.request, "sort", "risk");
  return listCustomers({
    search: queryParam(context.request, "search"),
    datasetId: queryParam(context.request, "datasetId"),
    risk:
      risk === "low" || risk === "medium" || risk === "high" || risk === "unscored"
        ? risk
        : "all",
    sort: SORTS.has(sort ?? "") ? (sort as "risk") : "risk",
    direction: queryParam(context.request, "direction") === "asc" ? "asc" : "desc",
    page: queryInt(context.request, "page", 1),
    pageSize: queryInt(context.request, "pageSize", 25),
  });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
