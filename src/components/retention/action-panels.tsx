"use client";

/**
 * Retention action panels: status transitions and editing.
 *
 * The status control only offers transitions the workflow actually allows, so
 * an invalid move is not something a user can attempt in the first place.
 */

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  changeActionStatusAction,
  updateRetentionActionAction,
  type ActionFormResult,
} from "@/app/actions/retention";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

const TRANSITIONS: Record<string, string[]> = {
  suggested: ["planned", "in_progress", "cancelled"],
  planned: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const LABELS: Record<string, string> = {
  suggested: "Suggested",
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
}: {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------

export function ActionStatusPanel({
  actionId,
  currentStatus,
}: {
  actionId: string;
  currentStatus: string;
}) {
  const [state, action] = useActionState<ActionFormResult | null, FormData>(
    changeActionStatusAction,
    null,
  );
  const [next, setNext] = useState(TRANSITIONS[currentStatus]?.[0] ?? "");
  const allowed = TRANSITIONS[currentStatus] ?? [];

  if (allowed.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        This action is closed, so its status cannot change.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="actionId" value={actionId} />
      <input type="hidden" name="status" value={next} />

      {state?.ok ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok ? (
        <FormAlert tone="critical">
          {state.message}
          {state.fields?.status ? (
            <p className="mt-1 text-xs">{state.fields.status}</p>
          ) : null}
        </FormAlert>
      ) : null}

      <Field
        label="Move to"
        name="nextStatus"
        options={allowed.map((status) => ({
          value: status,
          label: LABELS[status] ?? status,
        }))}
        value={next}
        onChange={(event) => setNext(event.target.value)}
        hint={
          next === "completed"
            ? "Records that the work was done. It does not record that the customer was retained."
            : next === "cancelled"
              ? "Records that this action will not be pursued."
              : undefined
        }
      />

      <Field
        label="Note"
        name="note"
        type="textarea"
        rows={2}
        placeholder="What happened? Recorded in the action's history."
      />

      <SubmitButton
        label={next ? `Mark as ${LABELS[next]?.toLowerCase()}` : "Update"}
        pendingLabel="Saving…"
        variant={next === "cancelled" ? "danger" : "primary"}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------

export function ActionEditForm({
  actionId,
  initialTitle,
  initialDescription,
  initialPriority,
  initialDueDate,
  initialNotes,
  assignees,
}: {
  actionId: string;
  initialTitle: string;
  initialDescription: string;
  initialPriority: string;
  initialDueDate: string;
  initialNotes: string;
  assignees: { id: string; fullName: string }[];
}) {
  const [state, action] = useActionState<ActionFormResult | null, FormData>(
    updateRetentionActionAction,
    null,
  );

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="actionId" value={actionId} />

      {state?.ok ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok ? (
        <FormAlert tone="critical">
          {state.message}
          {state.fields ? (
            <p className="mt-1 text-xs">{Object.values(state.fields).join(" ")}</p>
          ) : null}
        </FormAlert>
      ) : null}

      <Field
        label="Title"
        name="title"
        defaultValue={initialTitle}
        required
        error={state?.fields?.title}
      />
      <Field
        label="Detail"
        name="description"
        type="textarea"
        rows={3}
        defaultValue={initialDescription}
        error={state?.fields?.description}
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
          defaultValue={initialPriority}
          error={state?.fields?.priority}
        />
        <Field
          label="Follow-up date"
          name="dueDate"
          type="date"
          defaultValue={initialDueDate}
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
        defaultValue={initialNotes}
        error={state?.fields?.notes}
      />

      <SubmitButton label="Save changes" pendingLabel="Saving…" variant="secondary" />
    </form>
  );
}
