"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { requestPasswordResetAction, type FormResult } from "@/app/actions/auth";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" className="w-full" disabled={pending}>
      {pending ? "Sending…" : "Send reset link"}
    </Button>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState<FormResult | null, FormData>(
    requestPasswordResetAction,
    null,
  );

  return (
    <form action={action} className="space-y-4" noValidate>
      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <Field
        label="Email address"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="username"
        required
        error={state?.fields?.email}
        hint="We will send a link that works once and expires shortly."
      />

      <SubmitButton />
    </form>
  );
}
