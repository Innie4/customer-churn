/**
 * POST /api/auth/forgot-password
 *
 * Always reports success, whether or not the address is known, so this endpoint
 * cannot be used to discover which accounts exist.
 */

import { z } from "zod";
import { body, endpoint } from "@/lib/route";
import { requestPasswordReset } from "@/lib/dal/users";

const ForgotSchema = z.object({
  email: z
    .string()
    .trim()
    .min(3, "Enter your email address.")
    .max(320, "That email address is too long."),
});

export const POST = endpoint(
  "auth.forgot_password",
  { auth: false },
  async (context) => {
    const { email } = await body(context.request, ForgotSchema);
    await requestPasswordReset(email);
    return {
      message:
        "If an account exists for that address, a reset link is on its way. " +
        "The link expires shortly and can be used once.",
    };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
