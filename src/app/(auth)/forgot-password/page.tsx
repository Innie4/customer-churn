import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Reset your password
      </h1>
      <p className="mt-1.5 mb-6 text-sm text-ink-muted">
        Enter the address for your account. If it exists, a reset link is on its
        way.
      </p>
      <ForgotPasswordForm />
      <p className="mt-8 text-sm">
        <a
          href="/login"
          className="text-action underline underline-offset-2 hover:text-action-hover"
        >
          Back to sign in
        </a>
      </p>
    </div>
  );
}
