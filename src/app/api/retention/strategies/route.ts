/**
 * GET, POST /api/retention/strategies
 *
 * The retention strategy library. Strategies are model-informed suggestions
 * that a person approves before they are offered to anyone.
 */

import { z } from "zod";
import { AUDIT } from "@/lib/audit";
import { createStrategy, listStrategies } from "@/lib/dal/retention";
import { body, endpoint, queryParam } from "@/lib/route";

const StrategySchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(2000),
  triggeringCondition: z.string().trim().min(5).max(500),
  riskDriver: z.string().trim().min(2).max(200),
  sourceColumn: z.string().trim().max(200).optional(),
  suggestedIntervention: z.string().trim().min(10).max(2000),
  priority: z.enum(["low", "medium", "high", "critical"]),
  notes: z.string().trim().max(2000).optional(),
  derivedFromModelResultId: z.string().uuid().optional(),
});

export const GET = endpoint("retention.strategies_list", {}, async (context) => {
  const strategies = await listStrategies({
    status: queryParam(context.request, "status", "all"),
  });
  return { strategies, count: strategies.length };
});

export const POST = endpoint(
  "retention.strategy_create",
  {
    capability: "manageModels",
    status: 201,
    auditAction: AUDIT.strategyCreated,
    auditResource: (result) => {
      const strategy = result as { id?: string; title?: string };
      return strategy.id
        ? {
            resourceType: "strategy",
            resourceId: strategy.id,
            metadata: { title: strategy.title },
          }
        : null;
    },
  },
  async (context) => {
    const input = await body(context.request, StrategySchema);
    return createStrategy(input);
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
