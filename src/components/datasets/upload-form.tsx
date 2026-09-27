"use client";

/**
 * Dataset upload form.
 *
 * States, in order: idle, uploading, validated, failed. Each says what is
 * happening and what happens next, because an upload that silently fails is
 * indistinguishable from one that is still running.
 */

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { uploadDatasetAction, type ActionResult } from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      {pending ? "Uploading and inspecting…" : label}
    </Button>
  );
}

export function UploadDatasetForm({ maxBytes }: { maxBytes: number }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(
    uploadDatasetAction,
    null,
  );
  const [filename, setFilename] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A successful upload with a redirect target navigates from the client, so a
  // form that works without JavaScript still submits.
  useEffect(() => {
    if (state?.ok && state.redirectTo) {
      window.location.assign(state.redirectTo);
    }
  }, [state]);

  return (
    <form action={action} ref={formRef} className="space-y-4" noValidate>
      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <Field
        label="Dataset file"
        name="file"
        type="file"
        required
        accept=".csv,.tsv,.txt,text/csv"
        onFileSelected={setFilename}
        error={state?.fields?.file}
        hint={
          <>
            CSV, TSV or delimited text, up to {Math.round(maxBytes / (1024 * 1024))} MB.
            {filename ? ` Selected: ${filename}` : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="name"
          placeholder="Telco churn Q3"
          error={state?.fields?.name}
          hint="Defaults to the file name. Optional."
        />
        <Field
          label="Target column"
          name="targetColumn"
          placeholder="Churn"
          error={state?.fields?.targetColumn}
          hint="The column recording whether each customer churned. Optional if the file names it clearly."
        />
      </div>

      <Field
        label="Identifier columns"
        name="idColumns"
        placeholder="customerID"
        error={state?.fields?.idColumns}
        hint="Comma-separated. An identifier column is excluded from the model but used to match predictions back to customers."
      />

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label="Upload and inspect" />
        <button
          type="button"
          onClick={() => {
            formRef.current?.reset();
            setFilename(null);
          }}
          className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          Clear
        </button>
      </div>

      <p className="border-t border-line pt-3 text-xs text-ink-subtle">
        On upload the file is measured before anything is stored: row and column
        counts, missing values, duplicate rows, and whether the target column is
        usable. Nothing is hard-coded about any particular dataset.
      </p>
    </form>
  );
}
