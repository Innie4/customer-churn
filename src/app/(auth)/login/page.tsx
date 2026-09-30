import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { DemoAccountPicker } from "@/components/auth/demo-account-picker";
import { availableDemoAccounts } from "@/lib/demo-accounts";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign in.
 *
 * `next` carries the page the visitor was trying to reach, so signing in returns
 * them to where they were going rather than always to the dashboard.
 *
 * On a demo deployment the two demo accounts are offered above the form. The
 * helper that decides this returns nothing in production, so the buttons cannot
 * be rendered there even if the component were somehow reached.
 */
export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const raw = typeof params.next === "string" ? params.next : "/dashboard";
  // Only a same-site relative path is honoured, so `next` cannot be turned into
  // an open redirect.
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
  const demoAccounts = availableDemoAccounts();

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
      <p className="mt-1.5 mb-6 text-sm text-ink-muted">
        {demoAccounts.length > 0
          ? "Use the account issued to you, or open a demo account below."
          : "Use the account issued to you. Access is audited."}
      </p>

      {demoAccounts.length > 0 ? (
        <DemoAccountPicker accounts={demoAccounts} next={next} />
      ) : null}

      <p className="mb-4 text-xs font-medium uppercase tracking-wide text-ink-subtle">
        {demoAccounts.length > 0 ? "Or sign in with a password" : null}
      </p>

      <SignInForm next={next} />
      <p className="mt-8 text-xs text-ink-subtle">
        This platform holds customer data and model artifacts. Do not share
        credentials or sign in from an untrusted device.
      </p>
    </div>
  );
}
