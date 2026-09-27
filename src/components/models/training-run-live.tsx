"use client";

/**
 * Live training progress.
 *
 * Polls the run's own endpoint and refreshes when the status changes. Polling
 * stops as soon as the run reaches a terminal state, so an idle page does not
 * keep hitting the service.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Progress } from "@/components/ui";

interface RunState {
  status: string;
  stage: string;
  progressPercent: number;
  completedCount: number;
  failedCount: number;
  modelCount: number;
  durationSeconds: number | null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 4000;

export function TrainingRunLive({
  runId,
  initial,
}: {
  runId: string;
  initial?: RunState;
}) {
  const router = useRouter();
  const [state, setState] = useState<RunState | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled) return;
      setChecking(true);
      try {
        const response = await fetch(`/api/training/${runId}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as {
          data?: { run?: RunState };
          error?: { message?: string; nextAction?: string };
        };

        if (cancelled) return;

        if (!response.ok || !payload.data?.run) {
          setError(
            payload.error?.message ??
              "The training service could not be reached for an update.",
          );
          timer = setTimeout(poll, POLL_MS * 2);
          return;
        }

        const run = payload.data.run;
        setError(null);
        setState(run);

        if (TERMINAL.has(run.status)) {
          // The run has settled, so pull the server-rendered view once.
          router.refresh();
          return;
        }
        timer = setTimeout(poll, POLL_MS);
      } catch {
        if (!cancelled) {
          setError(
            "Lost contact with the server while following this run. The run " +
              "continues; the page will keep trying.",
          );
          timer = setTimeout(poll, POLL_MS * 2);
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    };

    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, router]);

  if (!state) {
    return (
      <p className="text-sm text-ink-muted">
        Following this run. Progress appears as the service reports it.
      </p>
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <Progress value={state.progressPercent} label={state.stage} />
      <p className="mt-2 text-xs text-ink-subtle">
        {state.completedCount} of {state.modelCount} model(s) complete
        {state.failedCount > 0 ? `, ${state.failedCount} failed` : ""}.{" "}
        {checking ? "Checking for updates…" : "Updates every few seconds."}
        {state.durationSeconds ? ` Elapsed ${state.durationSeconds.toFixed(0)}s.` : ""}
      </p>
      {error ? (
        <p className="mt-2 text-xs text-caution">
          {error} The run is unaffected; this page will keep trying.
        </p>
      ) : null}
    </div>
  );
}
