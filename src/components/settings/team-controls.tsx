"use client";

/**
 * Force a user off the platform.
 *
 * Calls a real administrator endpoint and reports what actually happened,
 * including when the user had no active sessions.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/interactive";

export function ForceSignOutButton({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  if (!confirming) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setResult(null);
          setConfirming(true);
        }}
      >
        Sign out
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-2xs text-ink-muted">
        Sign {displayName} out of every device?
      </span>
      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const response = await fetch(`/api/users/${userId}/sign-out`, {
                method: "POST",
              });
              const payload = (await response.json()) as {
                data?: { message: string };
                error?: { message: string; nextAction?: string };
              };
              if (response.ok && payload.data) {
                setResult({ ok: true, message: payload.data.message });
                setConfirming(false);
                router.refresh();
              } else {
                setResult({
                  ok: false,
                  message: `${payload.error?.message ?? "The sign-out failed."}${
                    payload.error?.nextAction ? ` ${payload.error.nextAction}` : ""
                  }`,
                });
              }
            });
          }}
        >
          {pending ? "Signing out…" : "Confirm"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
      {result ? (
        <span
          className={`max-w-56 text-right text-2xs ${
            result.ok ? "text-positive" : "text-critical"
          }`}
        >
          {result.message}
        </span>
      ) : null}
    </div>
  );
}
