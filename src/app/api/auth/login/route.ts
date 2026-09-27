/**
 * POST /api/auth/login
 *
 * Sign in with an email address and password. On success a session cookie is
 * set. The response contains the user summary and never the password hash or
 * the session token.
 */

import { z } from "zod";
import { body, endpoint } from "@/lib/route";
import { signIn } from "@/lib/dal/users";
import { clientAddress, clientUserAgent } from "@/lib/audit";

const LoginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(3, "Enter your email address.")
    .max(320, "That email address is too long."),
  password: z.string().min(1, "Enter your password.").max(200),
});

export const POST = endpoint("auth.login", { auth: false }, async (context) => {
  const { email, password } = await body(context.request, LoginSchema);
  const result = await signIn(email, password, {
    ipAddress: await clientAddress(),
    userAgent: await clientUserAgent(),
  });
  return { user: result.user };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
