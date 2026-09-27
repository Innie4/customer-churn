/**
 * GET /api/models/[id]/charts/[kind]
 *
 * Streams one of a model's rendered charts.
 *
 * The bytes live on the machine learning service, not in this process, so they
 * are fetched over HTTP and passed through here rather than read from disk. The
 * route exists so the chart is served behind the same session check as
 * everything else: the service is not exposed to the browser, so a chart cannot
 * be fetched without a valid session.
 */

import { AppError } from "@/lib/api";
import { getModelChart, ModelChartKind } from "@/lib/dal/models";
import { assertDatabaseReachable, endpoint } from "@/lib/route";

const KINDS = new Set<string>(Object.values(ModelChartKind));

export const GET = endpoint(
  "models.chart",
  {},
  async (context) => {
    await assertDatabaseReachable();
    const { id, kind } = await context.params;

    if (!KINDS.has(kind)) {
      throw AppError.notFound("That is not a chart this platform renders.");
    }

    const chart = await getModelChart(id, kind as ModelChartKind);
    if (!chart) {
      throw AppError.notFound(
        "No chart of that kind was recorded for this model.",
      );
    }

    // Returned as a Response so the bytes pass through unwrapped: see the
    // raw-response support in lib/route.ts.
    return new Response(new Uint8Array(chart.bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(chart.bytes.byteLength),
        "Content-Disposition": `inline; filename="${chart.filename}"`,
        // A model result is immutable once written, so a chart may be cached by
        // the browser. Private because it is behind a session.
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
