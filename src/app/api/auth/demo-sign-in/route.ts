/**
 * POST /api/auth/demo-sign-in
 *
 * Signs in as one of the demo accounts offered on the sign-in page, without a
 * password.
 *
 * This is an authentication bypass by design, so the guards are the whole
 * point of the file: it refuses in production, requires simulated mode and the
 * shared demo password, and accepts only a fixed account key rather than an
 * email address. See `src/lib/demo-accounts.ts` for why that last one matters.
 *
 * The response carries the user summary and never a token: the session is set
 * as an HttpOnly cookie, exactly as it is for a typed password.
 */

import { z } from "zod";
import { body, endpoint } from "@/lib/route";
import { signInAsDemoAccount } from "@/lib/demo-accounts";

const DemoSignInSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "Choose an account.")
    .max(40, "That is not one of the demo accounts."),
});

export const POST = endpoint(
  "auth.demoSignIn",
  { auth: false },
  async (context) => {
    const { key } = await body(context.request, DemoSignInSchema);
    const user = await signInAsDemoAccount(key);
    return { user };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";