/**
 * GET, PATCH /api/settings
 *
 * Platform settings. Risk thresholds are operator-editable and every change is
 * audited, because they change how every customer is banded.
 */

import { z } from "zod";
import { AUDIT } from "@/lib/audit";
import {
  getMlSettings,
  getRiskThresholds,
  listSettings,
  updateRiskThresholds,
} from "@/lib/dal/settings";
import { getDependencyStatus } from "@/lib/dal/reports";
import { validateConfig, ENV_SPECS } from "@/lib/env";
import { body, endpoint } from "@/lib/route";

const ThresholdsSchema = z.object({
  high: z.number().gt(0).lt(1),
  medium: z.number().gt(0).lt(1),
});

export const GET = endpoint("settings.get", {}, async () => {
  const [thresholds, ml, settings, dependencies] = await Promise.all([
    getRiskThresholds(),
    getMlSettings(),
    listSettings(),
    getDependencyStatus(),
  ]);
  return {
    thresholds,
    ml,
    settings,
    dependencies,
    // Reported so an operator can see what the deployment still needs, without
    // any value ever being exposed.
    configuration: { problems: validateConfig(), variables: ENV_SPECS.length },
  };
});

export const PATCH = endpoint(
  "settings.update",
  {
    // Administrators only. The risk thresholds decide how every customer in the
    // platform is banded, so changing them is a global, consequential decision
    // rather than an analyst's per-model choice.
    capability: "administer",
    auditAction: AUDIT.settingUpdated,
  },
  async (context) => {
    const input = await body(context.request, ThresholdsSchema);
    return { thresholds: await updateRiskThresholds(input) };
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
