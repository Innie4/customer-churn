/**
 * GET, POST /api/retention/actions
 *
 * Retention actions: the work a person committed to, and the state of it.
 */

import { z } from "zod";
import { AUDIT } from "@/lib/audit";
import { createAction, getRetentionSummary, listActions } from "@/lib/dal/retention";
import { body, endpoint, queryInt, queryParam } from "@/lib/route";

const CreateActionSchema = z.object({
  customerId: z.string().uuid("Choose a customer."),
  strategyId: z.string().uuid().optional(),
  predictionId: z.string().uuid().optional(),
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  assignedTo: z.string().uuid().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
    .optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const GET = endpoint("retention.actions_list", {}, async (context) => {
  const [page, summary] = await Promise.all([
    listActions({
      status: queryParam(context.request, "status", "all"),
      customerId: queryParam(context.request, "customerId"),
      assignedTo: queryParam(context.request, "assignedTo"),
      priority: queryParam(context.request, "priority", "all"),
      page: queryInt(context.request, "page", 1),
      pageSize: queryInt(context.request, "pageSize", 25),
    }),
    getRetentionSummary(),
  ]);
  return { ...page, summary };
});

export const POST = endpoint(
  "retention.action_create",
  {
    capability: "createActions",
    status: 201,
    auditAction: AUDIT.actionCreated,
    auditResource: (result) => {
      const action = result as { id?: string; customerId?: string; priority?: string };
      return action.id
        ? {
            resourceType: "retention_action",
            resourceId: action.id,
            metadata: { customerId: action.customerId, priority: action.priority },
          }
        : null;
    },
  },
  async (context) => {
    const input = await body(context.request, CreateActionSchema);
    return createAction(input);
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
