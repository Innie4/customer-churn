"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { resetPasswordAction, type FormResult } from "@/app/actions/auth";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/policy";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" className="w-full" disabled={pending}>
      {pending ? "Saving…" : "Set new password"}
    </Button>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState<FormResult | null, FormData>(
    resetPasswordAction,
    null,
  );

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <FormAlert tone="positive">{state.message}</FormAlert>
        <Button variant="primary" className="w-full">
          <a href="/login">Go to sign in</a>
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />

      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}
      {state?.fields?.token ? (
        <FormAlert tone="caution">
          {state.fields.token}{" "}
          <a
            href="/forgot-password"
            className="underline underline-offset-2"
          >
            Request a new link
          </a>
          .
        </FormAlert>
      ) : null}

      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={state?.fields?.password}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters, with an uppercase letter, a lowercase letter and a digit.`}
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={state?.fields?.confirmPassword}
      />

      <SubmitButton />
    </form>
  );
}
