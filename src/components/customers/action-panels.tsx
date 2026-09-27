"use client";

/**
 * Customer action panels: generate an explanation, create a retention action.
 *
 * The explanation button reports its own failure without hiding the prediction,
 * because a SHAP problem must never make the risk unreadable.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { explainCustomerAction } from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";
import { FormAlert } from "@/components/form";
import { CreateRetentionActionForm } from "@/components/retention/action-form";

// ---------------------------------------------------------------------------

export function ExplainButton({
  customerId,
  label = "Generate explanation",
}: {
  customerId: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant="primary"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await explainCustomerAction(customerId);
            if (!result.ok) {
              setError(result.message ?? "The explanation could not be generated.");
            }
            router.refresh();
          });
        }}
      >
        {pending ? "Generating…" : label}
      </Button>
      {error ? (
        <span className="max-w-xs text-right text-2xs text-critical">{error}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function CreateActionForm({
  customerId,
  strategyId,
  defaultTitle,
  defaultDescription,
  defaultPriority,
}: {
  customerId: string;
  strategyId?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultPriority?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  if (created) {
    return (
      <FormAlert tone="positive">
        Action created.{" "}
        <Link
          href="/retention"
          className="underline underline-offset-2"
        >
          Track it in the retention list
        </Link>
        .
      </FormAlert>
    );
  }

  if (!open) {
    return (
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        Create a retention action
      </Button>
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface-sunken p-3">
      <CreateRetentionActionForm
        customerId={customerId}
        strategyId={strategyId}
        initialTitle={defaultTitle}
        initialDescription={defaultDescription}
        initialPriority={defaultPriority}
        onDone={(message) => {
          setCreated(message);
          router.refresh();
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
