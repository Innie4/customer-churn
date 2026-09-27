/**
 * GET, PATCH /api/retention/actions/[id]
 *
 * One retention action, with its status history.
 */

import { z } from "zod";
import { AppError } from "@/lib/api";
import { AUDIT } from "@/lib/audit";
import {
  ACTION_STATUS_LABELS,
  changeActionStatus,
  getAction,
  getActionHistory,
  updateAction,
} from "@/lib/dal/retention";
import { body, endpoint } from "@/lib/route";

const PatchSchema = z
  .object({
    title: z.string().trim().min(3).max(300).optional(),
    description: z.string().trim().max(2000).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    assignedTo: z.string().uuid().optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
      .optional(),
    notes: z.string().trim().max(2000).optional(),
    status: z
      .enum(["suggested", "planned", "in_progress", "completed", "cancelled"])
      .optional(),
    statusNote: z.string().trim().max(1000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to change.",
  });

export const GET = endpoint("retention.action_get", {}, async (context) => {
  const { id } = await context.params;
  const action = await getAction(id);
  if (!action) {
    throw AppError.notFound(
      "That retention action does not exist.",
      "Go back to the retention list and choose another action.",
    );
  }
  return { action, history: await getActionHistory(id) };
});

export const PATCH = endpoint(
  "retention.action_update",
  {
    capability: "createActions",
    auditAction: AUDIT.actionUpdated,
  },
  async (context) => {
    const { id } = await context.params;
    const input = await body(context.request, PatchSchema);

    // A status change goes through the workflow, which records an event and
    // validates the transition. Everything else is a plain field edit.
    if (input.status) {
      const { status, statusNote, ...fields } = input;
      if (Object.keys(fields).length > 0) {
        await updateAction(id, fields);
      }
      return changeActionStatus(id, status, statusNote);
    }

    // statusNote changes only through a status transition, so it is
    // removed from the field spread rather than updated directly.
    const { statusNote: _statusNote, ...fields } = input;
    void _statusNote;
    return updateAction(id, fields);
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export { ACTION_STATUS_LABELS };
