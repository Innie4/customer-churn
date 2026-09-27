"use server";

/**
 * Server actions for authentication forms.
 *
 * Each returns a plain result object rather than throwing, so a form can render
 * a field-level message next to the input that caused it. The same underlying
 * functions back the API routes, so there is one implementation of sign-in
 * behaviour, not two.
 *
 * Every action re-resolves the session itself. A page-level check does not
 * extend to an action, so trusting the caller would be trusting the browser.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/api";
import { clientAddress, clientUserAgent } from "@/lib/audit";
import {
  MIN_PASSWORD_LENGTH,
  PasswordPolicyError,
  checkPasswordPolicy,
} from "@/lib/auth/password";
import { revokeSession } from "@/lib/auth/session";
import { getSession } from "@/lib/auth/session";
import { currentActor } from "@/lib/dal/access";
import {
  changeOwnPassword,
  completePasswordReset,
  requestPasswordReset,
  signIn,
  signOut,
  updateProfile,
} from "@/lib/dal/users";

export interface FormResult {
  ok: boolean;
  /** Message for the form as a whole. */
  message?: string;
  /** Messages for individual fields. */
  fields?: Record<string, string>;
}

function toFieldErrors(error: unknown): FormResult {
  if (error instanceof AppError) {
    return { ok: false, message: error.message, fields: error.fields };
  }
  if (error instanceof PasswordPolicyError) {
    return { ok: false, fields: { password: error.message } };
  }
  console.error("[action] unexpected failure", error);
  return {
    ok: false,
    message:
      "Something went wrong while processing that. Try again, and check the " +
      "server log if it keeps happening.",
  };
}

/** Only allow a same-site relative path, so `next` cannot be used as an open redirect. */
function safeNextPath(value: FormDataEntryValue | null): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export async function signInAction(
  _previous: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(formData.get("next"));

  if (!email) return { ok: false, fields: { email: "Enter your email address." } };
  if (!password) return { ok: false, fields: { password: "Enter your password." } };

  try {
    await signIn(email, password, {
      ipAddress: await clientAddress(),
      userAgent: await clientUserAgent(),
    });
  } catch (error) {
    return toFieldErrors(error);
  }

  // A redirect is thrown rather than returned, so it cannot be swallowed by the
  // action's own return type.
  redirect(next);
}

export async function requestPasswordResetAction(
  _previous: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { ok: false, fields: { email: "Enter your email address." } };
  }
  try {
    await requestPasswordReset(email);
  } catch (error) {
    return toFieldErrors(error);
  }
  // Deliberately identical whether or not the address exists.
  return {
    ok: true,
    message:
      "If an account exists for that address, a reset link is on its way. " +
      "The link expires shortly and can be used once.",
  };
}

export async function resetPasswordAction(
  _previous: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  const fields: Record<string, string> = {};
  if (token.length < 10) fields.token = "This link is incomplete. Request a new one.";
  try {
    checkPasswordPolicy(password);
  } catch (error) {
    if (error instanceof PasswordPolicyError) fields.password = error.message;
  }
  if (password !== confirm) {
    fields.confirmPassword = "The two passwords do not match.";
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  try {
    const outcome = await completePasswordReset(token, password);
    if (outcome.status !== "reset") {
      const messages: Record<string, string> = {
        invalid: "That reset link is not valid. Request a new one.",
        used: "That reset link has already been used. Request a new one.",
        expired: "That reset link has expired. Request a new one.",
      };
      return { ok: false, fields: { token: messages[outcome.status] } };
    }
  } catch (error) {
    return toFieldErrors(error);
  }

  return {
    ok: true,
    message:
      "Your password has been changed. Sign in with the new password. Any " +
      "other sessions have been signed out.",
  };
}

export async function signOutAction(): Promise<void> {
  await signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

export async function changePasswordAction(
  _previous: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  const fields: Record<string, string> = {};
  if (!currentPassword) {
    fields.currentPassword = "Enter your current password.";
  }
  try {
    checkPasswordPolicy(newPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) fields.newPassword = error.message;
  }
  if (newPassword !== confirm) {
    fields.confirmPassword = "The two passwords do not match.";
  }
  if (newPassword && newPassword.length < MIN_PASSWORD_LENGTH) {
    fields.newPassword = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  try {
    await changeOwnPassword(currentPassword, newPassword);
  } catch (error) {
    return toFieldErrors(error);
  }

  return {
    ok: true,
    message:
      "Your password has been changed and your other sessions have been " +
      "signed out.",
  };
}

export async function updateProfileAction(
  _previous: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const fullName = String(formData.get("fullName") ?? "").trim();
  const jobTitle = String(formData.get("jobTitle") ?? "").trim();
  const department = String(formData.get("department") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  const fields: Record<string, string> = {};
  if (fullName.length < 2 || fullName.length > 120) {
    fields.fullName = "Enter a name between 2 and 120 characters.";
  }
  if (phone && !/^[0-9+()\-.\s]{6,30}$/.test(phone)) {
    fields.phone = "Enter a phone number of 6 to 30 characters.";
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  try {
    await updateProfile({
      fullName,
      jobTitle: jobTitle || undefined,
      department: department || undefined,
      phone: phone || undefined,
    });
  } catch (error) {
    return toFieldErrors(error);
  }

  revalidatePath("/settings/profile");
  return { ok: true, message: "Your profile has been updated." };
}

/** Revoke the current session, used by the expired-session banner. */
export async function endCurrentSessionAction(): Promise<void> {
  const session = await getSession();
  if (session) await revokeSession(session.id);
  redirect("/login");
}

export async function currentActorEmail(): Promise<string | null> {
  const actor = await currentActor();
  return actor?.email ?? null;
}
