/**
 * GET /api/training/[id]
 *
 * One training run, reconciled with the machine learning service first so the
 * progress and metrics shown are current rather than as of the last poll.
 */

import { AppError } from "@/lib/api";
import { getModelRun, syncModelRun } from "@/lib/dal/models";
import { endpoint } from "@/lib/route";

export const GET = endpoint("training.get", {}, async (context) => {
  const { id } = await context.params;
  // A run that never reached the service, or that has already been copied
  // down, is served from the database without a service round trip.
  const existing = await getModelRun(id);
  if (!existing) {
    throw AppError.notFound(
      "That training run does not exist.",
      "Go back to the training history and choose another run.",
    );
  }
  if (
    existing.status === "queued" ||
    existing.status === "running" ||
    existing.status === "evaluating" ||
    existing.mlRunId === null
  ) {
    return { run: await syncModelRun(id), synced: true };
  }
  return { run: existing, synced: false };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
