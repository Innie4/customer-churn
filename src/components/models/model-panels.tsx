"use client";

/**
 * Model panels: activation, risk flagging, review resolution.
 *
 * Activation deliberately requires a written reason. It is the one decision
 * that determines which model a business acts on, so it is attributed and
 * explained rather than being a single click.
 */

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  activateModelAction,
  flagRiskAction,
  resolveRiskReviewAction,
  type ActionResult,
} from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  size = "md",
}: {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------

export function ActivateModelPanel({
  modelId,
  displayName,
}: {
  modelId: string;
  displayName: string;
}) {
  const [state, action] = useActionState<ActionResult | null, FormData>(
    activateModelAction,
    null,
  );
  const [reason, setReason] = useState("");

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="modelId" value={modelId} />

      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <Field
        label="Reason for activation"
        name="reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        required
        error={state?.fields?.reason}
        placeholder="e.g. Highest recall, and missed churners matter most to us"
        hint="Recorded in the audit trail with your name and the time. Say what trade-off you accepted, not just that you chose it."
      />

      <SubmitButton
        label={`Activate ${displayName}`}
        pendingLabel="Activating…"
      />

      <p className="text-xs text-ink-subtle">
        Activating deactivates the previous {displayName} model, so exactly one
        model of each family serves predictions. No model is ever promoted
        automatically.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function FlagRiskForm({ modelId }: { modelId: string }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(
    flagRiskAction,
    null,
  );

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="modelId" value={modelId} />

      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Feature"
          name="feature"
          required
          error={state?.fields?.feature}
          placeholder="SeniorCitizen"
          hint="Use the feature name as it appears in the importance list."
        />
        <Field
          label="Concern type"
          name="concernType"
          options={[
            { value: "proxy_risk", label: "May act as a proxy for a sensitive trait" },
            { value: "questionable_variable", label: "Questionable variable" },
            { value: "bias_concern", label: "Possible bias concern" },
            { value: "needs_review", label: "Needs review" },
          ]}
          defaultValue="needs_review"
        />
        <Field
          label="Severity"
          name="severity"
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
          defaultValue="medium"
        />
        <Field
          label="Notes"
          name="notes"
          type="textarea"
          rows={3}
          placeholder="What concerns you about this feature?"
        />
      </div>

      <SubmitButton label="Flag for review" pendingLabel="Saving…" size="sm" />
    </form>
  );
}

// ---------------------------------------------------------------------------

const OUTCOMES = [
  { value: "under_review", label: "Under review" },
  { value: "accepted", label: "Accept — use as is" },
  { value: "mitigated", label: "Mitigated" },
  { value: "rejected", label: "Reject" },
] as const;

export function ResolveRiskButtons({
  reviewId,
  modelId,
}: {
  reviewId: string;
  modelId: string;
}) {
  const [outcome, setOutcome] = useState<string>("under_review");
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, setPending] = useState(false);

  // A plain form post with useFormStatus would need a route; a server action
  // called directly keeps this consistent with the rest of the forms.
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const formData = new FormData();
    formData.set("reviewId", reviewId);
    formData.set("modelId", modelId);
    formData.set("status", outcome);
    const result = await resolveRiskReviewAction(formData);
    setState(result);
    setPending(false);
  };

  return (
    <form onSubmit={submit} className="flex items-center justify-end gap-1.5">
      <select
        value={outcome}
        onChange={(event) => setOutcome(event.target.value)}
        aria-label="Review outcome"
        className="rounded-control border border-line-strong bg-surface px-1.5 py-1 text-2xs text-ink"
      >
        {OUTCOMES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={pending}
        title={state?.message}
      >
        {pending ? "…" : "Save"}
      </Button>
    </form>
  );
}
