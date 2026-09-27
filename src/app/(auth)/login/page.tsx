import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign in.
 *
 * `next` carries the page the visitor was trying to reach, so signing in returns
 * them to where they were going rather than always to the dashboard.
 */
export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const raw = typeof params.next === "string" ? params.next : "/dashboard";
  // Only a same-site relative path is honoured, so `next` cannot be turned into
  // an open redirect.
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
      <p className="mt-1.5 mb-6 text-sm text-ink-muted">
        Use the account issued to you. Access is audited.
      </p>
      <SignInForm next={next} />
      <p className="mt-8 text-xs text-ink-subtle">
        This platform holds customer data and model artifacts. Do not share
        credentials or sign in from an untrusted device.
      </p>
    </div>
  );
}
