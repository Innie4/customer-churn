"use server";

/**
 * Retention strategies.
 *
 * A strategy moves through a review workflow, and approval is attributed. The
 * database enforces the same rule: a strategy cannot become approved without a
 * named approver.
 */

import { revalidatePath } from "next/cache";
import { AppError } from "@/lib/api";
import { currentActor, assertCan } from "@/lib/dal/access";
import { isUuid } from "@/lib/dal/datasets";
import {
  createStrategy,
  setStrategyStatus,
  type StrategyInput,
} from "@/lib/dal/retention";

export interface StrategyFormResult {
  ok: boolean;
  message?: string;
  fields?: Record<string, string>;
  createdId?: string;
}

function failure(error: unknown): StrategyFormResult {
  if (error instanceof AppError) {
    return {
      ok: false,
      message: `${error.message}${error.nextAction ? ` ${error.nextAction}` : ""}`,
      fields: error.fields,
    };
  }
  console.error("[action] strategy failure", error);
  return {
    ok: false,
    message: "The strategy could not be saved. Try again.",
  };
}

export async function createStrategyAction(
  _previous: StrategyFormResult | null,
  formData: FormData,
): Promise<StrategyFormResult> {
  const input: StrategyInput = {
    title: String(formData.get("title") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    triggeringCondition: String(formData.get("triggeringCondition") ?? "").trim(),
    riskDriver: String(formData.get("riskDriver") ?? "").trim(),
    sourceColumn: String(formData.get("sourceColumn") ?? "").trim() || null,
    suggestedIntervention: String(formData.get("suggestedIntervention") ?? "").trim(),
    priority: String(formData.get("priority") ?? "medium"),
    notes: String(formData.get("notes") ?? "").trim() || null,
  };

  try {
    assertCan(await currentActor(), "manageModels");
    const strategy = await createStrategy(input);
    revalidatePath("/retention/strategies");
    revalidatePath("/retention");
    return {
      ok: true,
      message: `Strategy "${strategy.title}" created as a draft. Approve it before it is offered to anyone.`,
      createdId: strategy.id,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function setStrategyStatusAction(
  _previous: StrategyFormResult | null,
  formData: FormData,
): Promise<StrategyFormResult> {
  const strategyId = String(formData.get("strategyId") ?? "");
  const status = String(formData.get("status") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || undefined;

  if (!isUuid(strategyId)) {
    return { ok: false, message: "That strategy id is not valid." };
  }
  if (
    !["draft", "proposed", "approved", "rejected", "retired"].includes(status)
  ) {
    return { ok: false, message: "Choose a valid review outcome." };
  }

  try {
    assertCan(await currentActor(), "manageModels");
    const strategy = await setStrategyStatus(
      strategyId,
      status as "draft" | "proposed" | "approved" | "rejected" | "retired",
      notes,
    );
    revalidatePath("/retention/strategies");
    return {
      ok: true,
      message: `Strategy "${strategy.title}" is now ${status}.`,
    };
  } catch (error) {
    return failure(error);
  }
}
