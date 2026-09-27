/**
 * GET /api/auth/session
 *
 * The current session, for a client that needs to know whether it is signed in
 * and how long is left. Returns 200 with `user: null` rather than 401 when
 * there is no session, so a client can tell "signed out" from "server error".
 */

import { endpoint } from "@/lib/route";
import { getSession } from "@/lib/auth/session";

export const GET = endpoint("auth.session", { auth: false }, async () => {
  const session = await getSession();
  if (!session) {
    return {
      user: null,
      expiresAt: null,
      secondsRemaining: 0,
    };
  }
  return {
    user: {
      id: session.id,
      email: session.email,
      fullName: session.fullName,
      role: session.role,
    },
    expiresAt: session.expiresAt,
    secondsRemaining: Math.max(
      0,
      Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000),
    ),
  };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
