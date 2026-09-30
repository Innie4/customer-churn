/**
 * Explanations for the simulated models.
 *
 * The application checks additivity itself: a local explanation's
 * contributions plus its base value must equal the customer's score on the
 * log-odds scale. Rather than generate contributions and then fudge the last
 * one to make the arithmetic work, contributions here are the same per-feature
 * terms that produced the customer's score, and whatever the linear terms do
 * not explain is reported honestly as an interaction term.
 *
 * The consequence is that a customer's probability, their waterfall, and the
 * global importance ranking are all computed from one source, so they cannot
 * tell three different stories.
 */

import {
  Customer,
  featureLabel,
  featureSourceColumn,
  featureKind,
} from "./population";
import { ModelType, modelProbability } from "./metrics";
import { logit, round } from "./rng";

export interface Contribution {
  feature: string;
  label: string;
  source_column: string;
  value: string;
  shap_value: number;
  direction: "increases_risk" | "reduces_risk";
  kind: string;
}

/** Rendered the way a customer would recognise the field on their record. */
function displayValue(customer: Customer, feature: string): string {
  const column = featureSourceColumn(feature);
  switch (column) {
    case "tenure":
      return `${customer.tenureMonths} months`;
    case "MonthlyCharges":
      return `$${customer.monthlyCharges.toFixed(2)}`;
    case "Contract":
      return customer.contract;
    case "InternetService":
      return customer.internetService;
    case "OnlineSecurity":
      return customer.onlineSecurity;
    case "TechSupport":
      return customer.techSupport;
    case "PaymentMethod":
      return customer.paymentMethod;
    case "PaperlessBilling":
      return customer.paperlessBilling;
    case "MultipleLines":
      return customer.multipleLines;
    case "Dependents":
      return customer.dependents;
    case "SeniorCitizen":
      return customer.seniorCitizen === 1 ? "Yes" : "No";
    default:
      return "Yes";
  }
}

/** The per-feature terms, taken from the population's own weights. */
function mainEffects(customer: Customer): { feature: string; shap: number }[] {
  // Reconstructing from the customer's attributes keeps the explanation tied
  // to their record rather than to a stored list that could drift from it.
  const effects: { feature: string; shap: number }[] = [];
  const add = (feature: string, weight: number) => {
    if (weight !== 0) effects.push({ feature, shap: weight });
  };

  if (customer.contract === "Month-to-month") add("Contract: Month-to-month", 1.62);
  else if (customer.contract === "One year") add("Contract: One year", -0.44);
  else add("Contract: Two year", -1.21);

  if (customer.internetService === "Fiber optic") add("InternetService: Fiber optic", 0.88);
  else if (customer.internetService === "No") add("InternetService: No", -0.51);

  if (customer.internetService !== "No" && customer.onlineSecurity === "No")
    add("OnlineSecurity: No", 0.62);
  if (customer.internetService !== "No" && customer.techSupport === "No")
    add("TechSupport: No", 0.49);

  if (customer.paymentMethod === "Electronic check")
    add("PaymentMethod: Electronic check", 0.74);
  else if (customer.paymentMethod === "Bank transfer")
    add("PaymentMethod: Bank transfer", -0.22);

  if (customer.paperlessBilling === "Yes") add("PaperlessBilling: Yes", 0.31);
  if (customer.multipleLines === "Yes" && customer.phoneService === "Yes")
    add("MultipleLines: Yes", 0.19);
  if (customer.dependents === "Yes") add("Dependents: Yes", -0.27);
  if (customer.seniorCitizen === 1) add("SeniorCitizen: 1", 0.24);

  if (customer.tenureMonths <= 12) add("tenure: short", 0.58);
  else if (customer.tenureMonths <= 48) add("tenure: medium", 0.12);
  else add("tenure: long", -0.94);

  if (customer.monthlyCharges >= 80) add("MonthlyCharges: high", 0.34);

  return effects;
}

/**
 * The mean log-odds of a model across the population, which is the base value
 * SHAP reports: the risk of an average customer before any feature is weighed.
 */
export function baseValueFor(
  customers: Customer[],
  modelType: ModelType,
): number {
  if (customers.length === 0) return 0;
  const total = customers.reduce(
    (sum, customer) => sum + logit(modelProbability(customer, modelType)),
    0,
  );
  return total / customers.length;
}

/**
 * Exact per-feature contributions for one customer.
 *
 * The returned list always satisfies
 * `baseValue + sum(shap_value) === logit(probability)` to within floating-point
 * tolerance, because the leftover is added as an explicit interaction term
 * rather than being absorbed into whichever feature happened to be last.
 */
export function contributionsFor(
  customer: Customer,
  modelType: ModelType,
  baseValue: number,
): { probability: number; baseValue: number; contributions: Contribution[] } {
  const probability = modelProbability(customer, modelType);
  const target = logit(probability) - baseValue;

  const contributions: Contribution[] = mainEffects(customer).map((effect) => ({
    feature: effect.feature,
    label: featureLabel(effect.feature),
    source_column: featureSourceColumn(effect.feature),
    value: displayValue(customer, effect.feature),
    shap_value: round(effect.shap, 4),
    direction: effect.shap >= 0 ? "increases_risk" : "reduces_risk",
    kind: featureKind(effect.feature),
  }));

  const explained = contributions.reduce((sum, entry) => sum + entry.shap_value, 0);
  const residual = round(target - explained, 4);

  // Anything the linear terms did not account for belongs to the tree models'
  // interaction effects. Reporting it under its own name is more honest than
  // inflating a real feature to hide it.
  if (Math.abs(residual) > 0.0005) {
    contributions.push({
      feature: "Interactions: residual",
      label: "Interactions between attributes",
      source_column: "(derived)",
      value: "Combined effect of interacting attributes",
      shap_value: residual,
      direction: residual >= 0 ? "increases_risk" : "reduces_risk",
      kind: "interaction",
    });
  }

  return { probability, baseValue, contributions };
}

const INCREASING_SUMMARY = (name: string) =>
  `${name} increases this customer's risk of churn.`;
const REDUCING_SUMMARY = (name: string) =>
  `${name} lowers this customer's risk of churn.`;

/** Rank the contributions and split them by direction, largest first. */
export function rankContributions(
  contributions: Contribution[],
  limit = 5,
): { top_increasing_risk: Contribution[]; top_reducing_risk: Contribution[] } {
  const increasing = contributions
    .filter((entry) => entry.shap_value > 0)
    .sort((a, b) => b.shap_value - a.shap_value);
  const reducing = contributions
    .filter((entry) => entry.shap_value < 0)
    .sort((a, b) => a.shap_value - b.shap_value);
  return {
    top_increasing_risk: increasing.slice(0, limit),
    top_reducing_risk: reducing.slice(0, limit),
  };
}

export function summariseRisk(customer: Customer, contributions: Contribution[]): string {
  const strongest = [...contributions].sort(
    (a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value),
  )[0];
  if (!strongest) {
    return `This customer's churn risk is close to the average for the population.`;
  }
  const text =
    strongest.shap_value >= 0
      ? INCREASING_SUMMARY(strongest.label)
      : REDUCING_SUMMARY(strongest.label);
  return `${text} Their contract is ${customer.contract.toLowerCase()} and they have been with the company ${customer.tenureMonths} months.`;
}

/**
 * Global importance, as the mean absolute contribution of each feature across
 * the population. Computed by averaging the same per-feature terms used for
 * the local explanations, so the ranking on the global page is the ranking
 * implied by the individual waterfalls.
 */
export function globalImportance(
  customers: Customer[],
  modelType: ModelType,
  baseValue: number,
): {
  feature: string;
  label: string;
  source_column: string;
  mean_abs_shap: number;
  direction: "increases_risk" | "reduces_risk" | "mixed";
  kind: string;
}[] {
  const totals = new Map<string, { abs: number; signed: number; count: number }>();

  for (const customer of customers) {
    const { contributions } = contributionsFor(customer, modelType, baseValue);
    for (const entry of contributions) {
      if (entry.kind === "interaction") continue;
      const current = totals.get(entry.feature) ?? { abs: 0, signed: 0, count: 0 };
      current.abs += Math.abs(entry.shap_value);
      current.signed += entry.shap_value;
      current.count += 1;
      totals.set(entry.feature, current);
    }
  }

  return [...totals.entries()]
    .map(([feature, total]) => ({
      feature,
      label: featureLabel(feature),
      source_column: featureSourceColumn(feature),
      // Dividing by the population rather than by the count of appearances
      // makes this a genuine mean over customers, so a feature held by a
      // minority does not look as important as one held by everyone.
      mean_abs_shap: round(total.abs / customers.length, 6),
      direction:
        total.signed > 0 ? ("increases_risk" as const)
        : total.signed < 0 ? ("reduces_risk" as const)
        : ("mixed" as const),
      kind: featureKind(feature),
    }))
    .sort((a, b) => b.mean_abs_shap - a.mean_abs_shap);
}

/** A risk band for a probability, given the configured thresholds. */
export function riskCategory(
  probability: number,
  thresholds: { high: number; medium: number },
): "low" | "medium" | "high" {
  if (probability >= thresholds.high) return "high";
  if (probability >= thresholds.medium) return "medium";
  return "low";
}

/** Confirm the additive identity the application enforces. */
export function contributionsAreExact(
  probability: number,
  baseValue: number,
  contributions: Contribution[],
): boolean {
  const total = contributions.reduce((sum, entry) => sum + entry.shap_value, 0);
  const expected = logit(probability) - baseValue;
  return Math.abs(total - expected) < 5e-3;
}
