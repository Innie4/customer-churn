"use client";

/**
 * Sign-out control.
 *
 * A real form posting a server action, so signing out works without client
 * JavaScript and cannot be triggered cross-site.
 */

import { useFormStatus } from "react-dom";
import { signOutAction } from "@/app/actions/auth";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-sunken disabled:text-ink-faint"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

export function SignOutButton({ email }: { email: string }) {
  return (
    <form action={signOutAction} className="px-3 pb-4">
      <p className="mb-2 truncate px-0.5 text-2xs text-ink-subtle" title={email}>
        {email}
      </p>
      <SubmitButton />
    </form>
  );
}
