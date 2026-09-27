/**
 * GET, POST /api/reports
 *
 * Report history and generation. A completed report always has a stored file;
 * the database constraint is what guarantees that.
 */

import { z } from "zod";
import { AUDIT } from "@/lib/audit";
import {
  REPORT_KIND_LABELS,
  generateReport,
  listReports,
} from "@/lib/dal/reports";
import { body, endpoint, queryInt } from "@/lib/route";

const GenerateSchema = z.object({
  kind: z.enum([
    "model_performance",
    "prediction_summary",
    "retention_summary",
    "dataset_summary",
    "shap_global",
    "audit_trail",
  ]),
  format: z.enum(["pdf", "csv"]),
  title: z.string().trim().min(3).max(300).optional(),
  datasetId: z.string().uuid().optional(),
  modelResultId: z.string().uuid().optional(),
  limit: z.number().int().min(5).max(500).optional(),
});

export const GET = endpoint("reports.list", {}, async (context) => {
  const reports = await listReports(queryInt(context.request, "limit", 50));
  return {
    reports,
    count: reports.length,
    kinds: REPORT_KIND_LABELS,
  };
});

export const POST = endpoint(
  "reports.generate",
  {
    capability: "manageModels",
    auditAction: AUDIT.reportGenerated,
    auditResource: (result) => {
      const report = result as { id?: string; kind?: string; format?: string };
      return report.id
        ? {
            resourceType: "report",
            resourceId: report.id,
            metadata: { kind: report.kind, format: report.format },
          }
        : null;
    },
  },
  async (context) => {
    const input = await body(context.request, GenerateSchema);
    return generateReport(input);
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
