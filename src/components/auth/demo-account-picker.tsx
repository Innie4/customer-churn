"use client";

/**
 * The demo account picker.
 *
 * Shown on the sign-in page when the deployment is a demo, so a visitor can
 * look around without being handed a password first. Each button posts the
 * account key and follows the redirect, so there is no second step.
 */

import { useState } from "react";
import type { DemoAccount } from "@/lib/demo-accounts";

const ROLE_LABELS: Record<DemoAccount["role"], string> = {
  admin: "Administrator",
  analyst: "Analyst",
  viewer: "Viewer",
};

export function DemoAccountPicker({
  accounts,
  next,
}: {
  accounts: readonly DemoAccount[];
  next: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enter(account: DemoAccount) {
    setBusy(account.key);
    setError(null);
    try {
      const response = await fetch("/api/auth/demo-sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: account.key }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "That account could not be opened.");
        setBusy(null);
        return;
      }
      // A full navigation rather than a client transition, so the server
      // components behind the destination are rendered with the new session
      // rather than reusing whatever the signed-out tree had cached.
      window.location.assign(next);
    } catch {
      setError("That account could not be opened. Check the connection.");
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="demo-accounts-heading" className="mb-6">
      <div className="rounded-card border border-line bg-surface-sunken p-4">
        <h2
          id="demo-accounts-heading"
          className="text-sm font-semibold text-ink"
        >
          Demo accounts
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Choose an account to open it. No password is needed, and every sign-in
          is still written to the audit trail.
        </p>

        <ul className="mt-3 grid gap-2">
          {accounts.map((account) => {
            const pending = busy === account.key;
            return (
              <li key={account.key}>
                <button
                  type="button"
                  onClick={() => enter(account)}
                  disabled={busy !== null}
                  className="w-full rounded-control border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-ink">
                      {account.displayName}
                    </span>
                    <span className="shrink-0 text-2xs uppercase tracking-wide text-ink-subtle">
                      {ROLE_LABELS[account.role]}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {account.email}
                  </span>
                  <span className="mt-1 block text-xs text-ink-subtle">
                    {account.summary}
                  </span>
                  <span className="mt-1.5 block text-xs font-medium text-action">
                    {pending ? "Opening…" : "Open this account →"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {error ? (
          <p role="alert" className="mt-2 text-xs text-critical">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}