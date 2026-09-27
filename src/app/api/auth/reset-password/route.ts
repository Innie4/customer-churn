/**
 * POST /api/auth/reset-password
 *
 * Complete a password reset. On success every existing session is invalidated,
 * because the epoch is bumped alongside the new password hash.
 */

import { z } from "zod";
import { AppError } from "@/lib/api";
import { body, endpoint } from "@/lib/route";
import { completePasswordReset } from "@/lib/dal/users";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

const ResetSchema = z.object({
  token: z.string().min(10, "The reset link is incomplete.").max(500),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const OUTCOMES: Record<string, string> = {
  invalid:
    "That reset link is not valid. Request a new one from the sign-in page.",
  used: "That reset link has already been used. Request a new one.",
  expired:
    "That reset link has expired. Request a new one from the sign-in page.",
};

export const POST = endpoint(
  "auth.reset_password",
  { auth: false },
  async (context) => {
    const { token, password } = await body(context.request, ResetSchema);
    const outcome = await completePasswordReset(token, password);
    if (outcome.status !== "reset") {
      throw AppError.badRequest(OUTCOMES[outcome.status] ?? "The link is not valid.", {
        code: `reset_${outcome.status}`,
        nextAction: "Request a new reset link and try again.",
      });
    }
    return {
      ok: true,
      message:
        "Your password has been changed. Sign in with the new password. Any " +
        "other sessions have been signed out.",
    };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
