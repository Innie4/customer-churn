/**
 * GET /api/reports/[id]
 *
 * One report's metadata and a short summary of what is inside it.
 */

import { AppError } from "@/lib/api";
import { getReport } from "@/lib/dal/reports";
import { endpoint } from "@/lib/route";

export const GET = endpoint("reports.get", {}, async (context) => {
  const { id } = await context.params;
  const report = await getReport(id);
  if (!report) {
    throw AppError.notFound(
      "That report does not exist.",
      "Go back to the report list and choose another.",
    );
  }
  return { report };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
