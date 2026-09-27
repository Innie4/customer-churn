/**
 * GET /api/audit
 *
 * The audit trail. Read-only by design: the table itself refuses updates and
 * deletes, so there is no write endpoint to protect.
 */

import { listAuditActions, listAuditEntries } from "@/lib/dal/reports";
import { endpoint, queryInt, queryParam } from "@/lib/route";

export const GET = endpoint("audit.list", {}, async (context) => {
  const [page, actions] = await Promise.all([
    listAuditEntries({
      action: queryParam(context.request, "action", "all"),
      outcome: queryParam(context.request, "outcome", "all"),
      resourceType: queryParam(context.request, "resourceType", "all"),
      actorId: queryParam(context.request, "actorId"),
      search: queryParam(context.request, "search"),
      page: queryInt(context.request, "page", 1),
      pageSize: queryInt(context.request, "pageSize", 50),
    }),
    listAuditActions(),
  ]);
  return { ...page, actions };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
