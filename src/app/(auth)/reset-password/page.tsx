import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

/**
 * Complete a password reset.
 *
 * A missing or malformed token is reported here rather than in the form, because
 * there is nothing the visitor can do with an empty page.
 */
export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  if (!token) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          This link is incomplete
        </h1>
        <p className="mt-2 mb-6 text-sm text-ink-muted">
          The reset link is missing its token. Open the link from your email, or
          request a new one.
        </p>
        <a
          href="/forgot-password"
          className="text-sm text-action underline underline-offset-2 hover:text-action-hover"
        >
          Request a new reset link
        </a>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Choose a new password
      </h1>
      <p className="mt-1.5 mb-6 text-sm text-ink-muted">
        Setting a new password signs out every other session.
      </p>
      <ResetPasswordForm token={token} />
    </div>
  );
}
