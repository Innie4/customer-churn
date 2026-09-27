"use client";

/**
 * Create a retention action.
 *
 * Reports field-level problems next to the field that caused them, and confirms
 * creation in place so the operator can see the result without navigating away
 * from the customer they are working on.
 */

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import {
  createRetentionActionAction,
  type ActionFormResult,
} from "@/app/actions/retention";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="sm" disabled={pending}>
      {pending ? "Creating…" : label}
    </Button>
  );
}

export function CreateRetentionActionForm({
  customerId,
  strategyId,
  initialTitle,
  initialDescription,
  initialPriority,
  assignees = [],
  onDone,
  onCancel,
}: {
  customerId: string;
  strategyId?: string;
  initialTitle?: string;
  initialDescription?: string;
  initialPriority?: string;
  assignees?: { id: string; fullName: string }[];
  onDone?: (message: string) => void;
  onCancel?: () => void;
}) {
  const [state, action] = useActionState<ActionFormResult | null, FormData>(
    createRetentionActionAction,
    null,
  );

  // The success callback is a side effect, so it runs in an effect. Calling it
  // during render would set state on the parent while rendering this component,
  // which React does not support.
  const notified = useRef(false);
  useEffect(() => {
    if (!state?.ok || notified.current) return;
    notified.current = true;
    onDone?.(state.message ?? "Action created.");
  }, [state, onDone]);

  if (state?.ok && onDone) {
    return null;
  }

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="customerId" value={customerId} />
      {strategyId ? (
        <input type="hidden" name="strategyId" value={strategyId} />
      ) : null}

      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <Field
        label="What will be done"
        name="title"
        defaultValue={initialTitle}
        required
        error={state?.fields?.title}
        placeholder="Call the customer about a contract upgrade"
      />

      <Field
        label="Detail"
        name="description"
        type="textarea"
        rows={3}
        defaultValue={initialDescription}
        error={state?.fields?.description}
        placeholder="What exactly should happen, and why?"
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Priority"
          name="priority"
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "critical", label: "Critical" },
          ]}
          defaultValue={
            initialPriority === "critical" ? "high" : initialPriority ?? "medium"
          }
          error={state?.fields?.priority}
        />
        <Field
          label="Follow-up date"
          name="dueDate"
          type="date"
          error={state?.fields?.dueDate}
        />
        <Field
          label="Assign to"
          name="assignedTo"
          options={[
            { value: "", label: "Unassigned" },
            ...assignees.map((person) => ({
              value: person.id,
              label: person.fullName,
            })),
          ]}
          error={state?.fields?.assignedTo}
        />
      </div>

      <Field
        label="Notes"
        name="notes"
        type="textarea"
        rows={2}
        error={state?.fields?.notes}
        placeholder="Context for whoever picks this up."
      />

      <div className="flex flex-wrap gap-2">
        <SubmitButton label="Create action" />
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
