"use server";

/**
 * Retention actions.
 *
 * Creating and progressing an action are separate actions, because they are
 * separate decisions. An action that is only "suggested" is a real state: it
 * records that the platform raised something and a person has not yet decided.
 */

import { revalidatePath } from "next/cache";
import { AppError } from "@/lib/api";
import { currentActor, assertCan } from "@/lib/dal/access";
import {
  ACTION_TRANSITIONS,
  changeActionStatus,
  createAction,
  updateAction,
  type ActionStatus,
} from "@/lib/dal/retention";
import { isUuid } from "@/lib/dal/datasets";

export interface ActionFormResult {
  ok: boolean;
  message?: string;
  fields?: Record<string, string>;
  createdId?: string;
}

function failure(error: unknown): ActionFormResult {
  if (error instanceof AppError) {
    return {
      ok: false,
      message: `${error.message}${error.nextAction ? ` ${error.nextAction}` : ""}`,
      fields: error.fields,
    };
  }
  console.error("[action] retention failure", error);
  return {
    ok: false,
    message:
      "The action could not be saved. Try again, and check the server log if " +
      "it keeps happening.",
  };
}

export async function createRetentionActionAction(
  _previous: ActionFormResult | null,
  formData: FormData,
): Promise<ActionFormResult> {
  const customerId = String(formData.get("customerId") ?? "");
  const strategyId = String(formData.get("strategyId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const priority = String(formData.get("priority") ?? "medium");
  const assignedTo = String(formData.get("assignedTo") ?? "");
  const dueDate = String(formData.get("dueDate") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();

  const fields: Record<string, string> = {};
  if (!isUuid(customerId)) fields.customerId = "That customer id is not valid.";
  if (title.length < 3) {
    fields.title = "Describe the action in at least 3 characters.";
  }
  if (assignedTo && !isUuid(assignedTo)) {
    fields.assignedTo = "Choose someone from the list.";
  }
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    fields.dueDate = "Use the date picker.";
  }
  if (!["low", "medium", "high", "critical"].includes(priority)) {
    fields.priority = "Choose a priority.";
  }
  if (Object.keys(fields).length > 0) {
    return { ok: false, message: "Check the highlighted fields.", fields };
  }

  try {
    assertCan(await currentActor(), "createActions");
    const action = await createAction({
      customerId,
      strategyId: strategyId && isUuid(strategyId) ? strategyId : null,
      title,
      description: description || null,
      priority,
      assignedTo: assignedTo && isUuid(assignedTo) ? assignedTo : null,
      dueDate: dueDate || null,
      notes: notes || null,
    });

    revalidatePath(`/customers/${customerId}`);
    revalidatePath("/retention");
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: `Action "${action.title}" created for customer ${action.customerExternalId}.`,
      createdId: action.id,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function updateRetentionActionAction(
  _previous: ActionFormResult | null,
  formData: FormData,
): Promise<ActionFormResult> {
  const actionId = String(formData.get("actionId") ?? "");
  if (!isUuid(actionId)) {
    return { ok: false, message: "That action id is not valid." };
  }
  try {
    assertCan(await currentActor(), "createActions");
    const action = await updateAction(actionId, {
      title: String(formData.get("title") ?? "").trim() || undefined,
      description: String(formData.get("description") ?? "").trim() || undefined,
      priority: String(formData.get("priority") ?? "") || undefined,
      assignedTo: String(formData.get("assignedTo") ?? "") || undefined,
      dueDate: String(formData.get("dueDate") ?? "") || undefined,
      notes: String(formData.get("notes") ?? "").trim() || undefined,
    });
    revalidatePath(`/retention/${actionId}`);
    revalidatePath("/retention");
    return { ok: true, message: `Action "${action.title}" updated.` };
  } catch (error) {
    return failure(error);
  }
}

/** Move an action to a new status, recording the transition. */
export async function changeActionStatusAction(
  _previous: ActionFormResult | null,
  formData: FormData,
): Promise<ActionFormResult> {
  const actionId = String(formData.get("actionId") ?? "");
  const status = String(formData.get("status") ?? "") as ActionStatus;
  const note = String(formData.get("note") ?? "").trim();

  if (!isUuid(actionId)) {
    return { ok: false, message: "That action id is not valid." };
  }
  if (!status || !(status in ACTION_TRANSITIONS)) {
    return { ok: false, message: "Choose a valid status." };
  }

  try {
    assertCan(await currentActor(), "createActions");
    const action = await changeActionStatus(actionId, status, note || undefined);
    revalidatePath(`/retention/${actionId}`);
    revalidatePath("/retention");
    revalidatePath(`/customers/${action.customerId}`);
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: `Action "${action.title}" is now ${status.replace(/_/g, " ")}.`,
    };
  } catch (error) {
    return failure(error);
  }
}
