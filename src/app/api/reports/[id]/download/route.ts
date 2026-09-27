/**
 * GET /api/reports/[id]/download
 *
 * Streams a generated report's bytes.
 *
 * The file is never exposed through a guessable public path. It is read from
 * the private storage directory here, behind the same session check as every
 * other endpoint, and served with a filename derived from the report title.
 */

import { AppError } from "@/lib/api";
import { readReportFile } from "@/lib/dal/reports";
import { assertDatabaseReachable, endpoint } from "@/lib/route";

export const GET = endpoint("reports.download", {}, async (context) => {
  await assertDatabaseReachable();
  const { id } = await context.params;
  const { buffer, filename, contentType } = await readReportFile(id);
  if (buffer.byteLength === 0) {
    throw AppError.internal("The stored report file is empty.");
  }

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
      // Attached rather than shown inline, so a report cannot execute in a
      // browsing context.
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
