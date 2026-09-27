/**
 * POST /api/auth/logout
 *
 * Revokes the current session server-side and clears the cookie. The row is
 * deleted by revocation, so a copied cookie stops working immediately.
 *
 * Deliberately accepts a request with no session. Signing out is idempotent:
 * the desired end state is "no session", and if that is already true there is
 * nothing to do but say so. Returning 401 here would mean a person whose
 * session had just expired was shown an error for signing out.
 */

import { endpoint } from "@/lib/route";
import { getSession } from "@/lib/auth/session";
import { signOut } from "@/lib/dal/users";

export const POST = endpoint(
  "auth.logout",
  { auth: false },
  async () => {
    // Cleared whether or not a session existed, so the cookie always goes.
    const had = Boolean(await getSession());
    await signOut();
    return { ok: true, hadSession: had };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
