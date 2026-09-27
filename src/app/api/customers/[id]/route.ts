/**
 * GET /api/customers/[id]
 *
 * A customer with the four things the detail page has to answer: who this is,
 * how much risk is present, why the model says so, and what to consider doing.
 */

import { AppError } from "@/lib/api";
import {
  getCustomer,
  getExplanationForPrediction,
  suggestStrategiesForCustomer,
} from "@/lib/dal/customers";
import { getRetentionSummary } from "@/lib/dal/retention";
import { endpoint } from "@/lib/route";

export const GET = endpoint("customers.get", {}, async (context) => {
  const { id } = await context.params;
  const customer = await getCustomer(id);
  if (!customer) {
    throw AppError.notFound(
      "That customer does not exist.",
      "Go back to the customer list and search again.",
    );
  }

  const [explanation, strategies] = await Promise.all([
    customer.predictionId
      ? getExplanationForPrediction(customer.predictionId)
      : Promise.resolve(null),
    suggestStrategiesForCustomer(id),
  ]);

  return {
    customer: { ...customer, strategies },
    explanation,
    retentionSummary: await getRetentionSummary(),
  };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
