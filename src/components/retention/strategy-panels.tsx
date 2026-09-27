"use client";

/**
 * Strategy creation and review.
 *
 * A strategy is created as a draft and has to be approved before it reaches a
 * customer page, so the review control is offered alongside every strategy.
 */

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createStrategyAction,
  setStrategyStatusAction,
  type StrategyFormResult,
} from "@/app/actions/strategies";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  size = "sm",
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

export function StrategyForm() {
  const [state, action] = useActionState<StrategyFormResult | null, FormData>(
    createStrategyAction,
    null,
  );

  return (
    <form action={action} className="space-y-3" noValidate>
      {state?.ok ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok ? (
        <FormAlert tone="critical">
          {state.message}
          {state.fields ? (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {Object.values(state.fields).map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </FormAlert>
      ) : null}

      <Field
        label="Title"
        name="title"
        required
        error={state?.fields?.title}
        placeholder="Offer a contract upgrade incentive"
        hint="What the retention team would do, in a few words."
      />

      <Field
        label="Description"
        name="description"
        type="textarea"
        rows={2}
        required
        error={state?.fields?.description}
        placeholder="Why this is worth doing, in business terms."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Risk driver"
          name="riskDriver"
          required
          error={state?.fields?.riskDriver}
          placeholder="Contract: Month-to-month"
          hint="The model-identified driver this responds to."
        />
        <Field
          label="Source column"
          name="sourceColumn"
          error={state?.fields?.sourceColumn}
          placeholder="Contract"
          hint="Used to match this strategy against a customer's SHAP contributions. Without it the strategy can never be suggested."
        />
      </div>

      <Field
        label="When it applies"
        name="triggeringCondition"
        type="textarea"
        rows={2}
        required
        error={state?.fields?.triggeringCondition}
        placeholder="The customer is on a month-to-month contract and the model has flagged that as pushing their risk up."
      />

      <Field
        label="Suggested intervention"
        name="suggestedIntervention"
        type="textarea"
        rows={2}
        required
        error={state?.fields?.suggestedIntervention}
        placeholder="Offer a bill credit or device upgrade in exchange for a 12-month commitment."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Priority"
          name="priority"
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "critical", label: "Critical" },
          ]}
          defaultValue="medium"
          error={state?.fields?.priority}
        />
        <Field
          label="Notes"
          name="notes"
          type="textarea"
          rows={2}
          error={state?.fields?.notes}
        />
      </div>

      <SubmitButton
        label="Create as draft"
        pendingLabel="Creating…"
        variant="secondary"
        size="md"
      />
    </form>
  );
}

// ---------------------------------------------------------------------------

const NEXT_STATUS: Record<string, { value: string; label: string }[]> = {
  draft: [
    { value: "proposed", label: "Propose for review" },
    { value: "rejected", label: "Reject" },
  ],
  proposed: [
    { value: "approved", label: "Approve" },
    { value: "rejected", label: "Reject" },
  ],
  approved: [{ value: "retired", label: "Retire" }],
  rejected: [{ value: "draft", label: "Reopen as draft" }],
  retired: [{ value: "draft", label: "Reopen as draft" }],
};

export function StrategyStatusControl({
  strategyId,
  currentStatus,
}: {
  strategyId: string;
  currentStatus: string;
}) {
  const [state, action] = useActionState<StrategyFormResult | null, FormData>(
    setStrategyStatusAction,
    null,
  );
  const options = NEXT_STATUS[currentStatus] ?? [];
  const [chosen, setChosen] = useState(options[0]?.value ?? "");

  if (options.length === 0) {
    return <span className="text-2xs text-ink-faint">—</span>;
  }

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="strategyId" value={strategyId} />
      <input type="hidden" name="status" value={chosen} />
      <div className="flex items-center gap-1">
        <select
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
          aria-label="Review outcome"
          className="rounded-control border border-line-strong bg-surface px-1.5 py-1 text-2xs text-ink"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <SubmitButton label="Save" pendingLabel="…" variant="secondary" />
      </div>
      {state?.message ? (
        <span
          className={`max-w-40 text-right text-2xs ${
            state.ok ? "text-positive" : "text-critical"
          }`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
