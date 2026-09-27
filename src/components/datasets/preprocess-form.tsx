"use client";

/**
 * Preprocessing settings.
 *
 * The defaults are the documented methodology, so submitting without changing
 * anything reproduces the study's workflow exactly.
 */

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { preprocessDatasetAction, type ActionResult } from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";
import { Checkbox, Field, FormAlert } from "@/components/form";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      {pending ? "Preprocessing…" : "Run preprocessing"}
    </Button>
  );
}

export function PreprocessForm({
  datasetId,
  targetColumn,
  candidateIdColumns,
  rowCount,
}: {
  datasetId: string;
  targetColumn: string;
  candidateIdColumns: string[];
  rowCount: number | null;
}) {
  const [state, action] = useActionState<ActionResult | null, FormData>(
    preprocessDatasetAction,
    null,
  );
  const [testSize, setTestSize] = useState("0.2");
  const [idColumns, setIdColumns] = useState(
    candidateIdColumns[0] ?? "",
  );

  useEffect(() => {
    if (state?.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state]);

  const testRows =
    rowCount && Number.isFinite(Number(testSize))
      ? Math.round(rowCount * Number(testSize))
      : null;

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="datasetId" value={datasetId} />

      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <Field
        label="Target column"
        name="targetColumn"
        defaultValue={targetColumn}
        error={state?.fields?.targetColumn}
        hint="The column recording whether each customer churned. Must contain Yes or No."
        required
      />

      <Field
        label="Identifier columns"
        name="idColumns"
        value={idColumns}
        onChange={(event) => setIdColumns(event.target.value)}
        placeholder="customerID"
        error={state?.fields?.idColumns}
        hint={
          candidateIdColumns.length > 0
            ? `Comma-separated. Suggested from this file: ${candidateIdColumns.join(", ")}. Excluded from the model, but used to match predictions back to customers.`
            : "Comma-separated. Excluded from the model, but used to match predictions back to customers."
        }
      />

      <Field
        label="Test share"
        name="testSize"
        type="number"
        min="0.05"
        max="0.5"
        step="0.05"
        value={testSize}
        onChange={(event) => setTestSize(event.target.value)}
        error={state?.fields?.testSize}
        hint={
          testRows
            ? `That leaves about ${testRows.toLocaleString()} of ${rowCount?.toLocaleString()} rows for the held-out test split.`
            : "Between 0.05 and 0.5. The documented workflow uses 0.2."
        }
      />

      <div className="space-y-2.5">
        <Checkbox
          label="Stratify the split on the churn target"
          name="stratify"
          defaultChecked
          hint="Keeps the churn rate the same in both splits, so the test set is a fair sample."
        />
        <Checkbox
          label="Apply SMOTE to the training split"
          name="applySmote"
          defaultChecked
          hint="Balances the churn class during training. The test split is never resampled, so evaluation still reflects the real class distribution."
        />
      </div>

      <SubmitButton />

      <p className="border-t border-line pt-3 text-xs text-ink-subtle">
        Preprocessing records every step, the row counts at each stage, and the
        exact random seed, so a run can be reproduced and audited. Customer
        records are loaded from the same file immediately afterwards.
      </p>
    </form>
  );
}
