"use client";

/** Profile and password forms. */

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  changePasswordAction,
  updateProfileAction,
  type FormResult,
} from "@/app/actions/auth";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function ProfileForm({
  fullName,
  email,
  jobTitle,
  department,
  phone,
}: {
  fullName: string;
  email: string;
  jobTitle: string;
  department: string;
  phone: string;
}) {
  const [state, action] = useActionState<FormResult | null, FormData>(
    updateProfileAction,
    null,
  );

  return (
    <form action={action} className="space-y-3" noValidate>
      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <Field
        label="Full name"
        name="fullName"
        defaultValue={fullName}
        required
        autoComplete="name"
        error={state?.fields?.fullName}
      />
      <Field
        label="Email address"
        name="email"
        type="email"
        defaultValue={email}
        disabled
        hint="Your address is how you sign in and cannot be changed here. Ask an administrator."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Job title" name="jobTitle" defaultValue={jobTitle} />
        <Field label="Department" name="department" defaultValue={department} />
      </div>
      <Field
        label="Phone"
        name="phone"
        type="tel"
        inputMode="tel"
        defaultValue={phone}
        error={state?.fields?.phone}
        hint="Optional."
      />

      <SubmitButton label="Save profile" pendingLabel="Saving…" />
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState<FormResult | null, FormData>(
    changePasswordAction,
    null,
  );

  return (
    <form action={action} className="space-y-3" noValidate>
      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        error={state?.fields?.currentPassword}
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        error={state?.fields?.newPassword}
        hint="At least 12 characters, with an uppercase letter, a lowercase letter and a digit."
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={state?.fields?.confirmPassword}
      />

      <SubmitButton label="Change password" pendingLabel="Changing…" />
    </form>
  );
}
