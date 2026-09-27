"use client";

/**
 * Re-run validation for a dataset.
 *
 * Wrapped in a form posting a server action, so it works without client
 * JavaScript, and reports its own progress and failure.
 */

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import {
  revalidateDatasetAction,
  type ActionResult,
} from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" size="sm" disabled={pending}>
      {pending ? "Validating…" : label}
    </Button>
  );
}

export function RevalidateDatasetButton({
  datasetId,
  label = "Re-run validation",
}: {
  datasetId: string;
  label?: string;
}) {
  const [state, action] = useActionState<ActionResult | null, FormData>(
    revalidateDatasetAction,
    null,
  );

  useEffect(() => {
    if (state?.redirectTo) window.location.assign(state.redirectTo);
  }, [state]);

  return (
    <form action={action} className="inline-flex flex-col items-end gap-1.5">
      <input type="hidden" name="datasetId" value={datasetId} />
      <SubmitButton label={label} />
      {state?.message ? (
        <span
          className={`max-w-xs text-right text-2xs ${
            state.ok ? "text-positive" : "text-critical"
          }`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
