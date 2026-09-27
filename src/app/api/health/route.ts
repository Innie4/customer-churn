/**
 * GET /api/health
 *
 * Liveness for the platform and its dependencies. Deliberately public and
 * deliberately free of detail: it reports whether each dependency answers, and
 * nothing about the configuration, the version history or the data.
 */

import { NextResponse } from "next/server";
import { getDatabase } from "../../../../db/client";
import { mlServiceReachable } from "@/lib/ml-client";
import { validateConfig } from "@/lib/env";

export const GET = async () => {
  const database = await checkDatabase();
  const ml = await mlServiceReachable();
  const problems = validateConfig();

  const healthy = database === "ok" && ml !== null;
  const body = {
    status: healthy ? (problems.length > 0 ? "degraded" : "ok") : "unhealthy",
    dependencies: {
      database: { status: database },
      mlService: {
        status: ml === null ? "unreachable" : "ok",
        // The library versions are operationally useful and contain no secrets.
        libraryVersions: ml?.library_versions ?? null,
      },
    },
    // Counts of unmet configuration requirements, never their values.
    configurationProblems: problems.map((problem) => problem.variable),
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
};

async function checkDatabase(): Promise<"ok" | "unreachable"> {
  try {
    const db = await getDatabase();
    await db.query("SELECT 1");
    return "ok";
  } catch {
    return "unreachable";
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
