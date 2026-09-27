"use client";

/**
 * Sign-in form.
 *
 * A real form posting through a server action, so it works without client
 * JavaScript and reports field-level errors next to the field that caused them.
 */

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signInAction, type FormResult } from "@/app/actions/auth";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" className="w-full" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

export function SignInForm({ next }: { next: string }) {
  const [state, action] = useActionState<FormResult | null, FormData>(
    signInAction,
    null,
  );

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />

      {state?.message ? <FormAlert tone="critical">{state.message}</FormAlert> : null}

      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="username"
        required
        error={state?.fields?.email}
        defaultValue=""
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={state?.fields?.password}
      />

      <div className="flex items-center justify-between">
        <SubmitButton />
        <a
          href="/forgot-password"
          className="text-sm text-action underline underline-offset-2 hover:text-action-hover"
        >
          Forgot password?
        </a>
      </div>
    </form>
  );
}
