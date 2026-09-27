/**
 * POST /api/users/[id]/sign-out
 *
 * Administrators only. Revokes every session for a user and bumps their session
 * epoch, so anything issued beforehand stops working immediately.
 */

import { AppError } from "@/lib/api";
import { AUDIT } from "@/lib/audit";
import { currentActor } from "@/lib/dal/access";
import { forceSignOut, getUser } from "@/lib/dal/users";
import { endpoint } from "@/lib/route";

export const POST = endpoint(
  "users.force_sign_out",
  { capability: "administer", auditAction: AUDIT.loggedOut },
  async (context) => {
    const { id } = await context.params;
    const actor = await currentActor();
    if (!actor) throw AppError.unauthorized();
    if (actor.id === id) {
      throw AppError.badRequest(
        "You are already signed in on this device. Use sign out instead.",
      );
    }

    const user = await getUser(id);
    if (!user) {
      throw AppError.notFound(
        "That user does not exist.",
        "Go back to the team list and choose another user.",
      );
    }

    const revoked = await forceSignOut(id);
    return {
      ok: true,
      userId: id,
      email: user.email,
      sessionsRevoked: revoked,
      message:
        revoked > 0
          ? `${user.fullName} has been signed out of ${revoked} session(s).`
          : `${user.fullName} had no active sessions.`,
    };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
