/**
 * Evaluation maths for the simulated models.
 *
 * Nothing here invents a performance figure. Scores and labels go in, and the
 * confusion matrix, accuracy, precision, recall, F1, ROC curve, AUC and decile
 * lift all come back out of that one sample. That is what stops the model page
 * showing an AUC of 0.84 next to a confusion matrix that implies 0.79, which
 * is the failure mode a hand-written fixture always eventually hits.
 */

import { Customer } from "./population";
import { Rng, logit, round, sigmoid } from "./rng";

export interface ScoredSample {
  customer: Customer;
  score: number;
  label: 0 | 1;
}

export type ModelType = "logistic_regression" | "random_forest" | "xgboost";

/**
 * A model's probability for one customer.
 *
 * Logistic regression is the generating model, so its probability is the latent
 * log-odds passed through the logistic function. The tree models add
 * interactions the linear model cannot express and then saturate, because a
 * boosted tree pushes probabilities away from zero and one faster than a
 * linear model does.
 *
 * The per-customer perturbation is derived from the customer's own id, so the
 * same customer always scores the same. A shared random stream would make
 * numbers change between page loads, which looks like a bug to anyone reading
 * the demo.
 */
export function modelProbability(
  customer: Customer,
  modelType: ModelType,
): number {
  const latent = logit(customer.baseProbability);

  if (modelType === "logistic_regression") {
    return sigmoid(latent);
  }

  const rng = new Rng(`${customer.customerId}:${modelType}`);
  // Trees pick up interactions between contract length and tenure, and between
  // fibre and month-to-month, that the linear term misses.
  const interaction =
    (customer.contract === "Month-to-month" ? 0.34 : -0.19) *
    (customer.tenureMonths < 24 ? 1 : 0.35) +
    (customer.internetService === "Fiber optic" && customer.contract === "Month-to-month" ? 0.27 : 0);

  const adjusted = latent + interaction;
  // Saturating squashing: pushes extremes further out, like a real tree.
  const squashed = Math.tanh(adjusted / 1.9) * 1.9;
  // A small customer-specific offset keeps the three models from ranking
  // identically, which is what the real run looked like too.
  return sigmoid(squashed + rng.normal(0, 0.06));
}

export function scorePopulation(
  customers: Customer[],
  modelType: ModelType,
): ScoredSample[] {
  return customers.map((customer) => ({
    customer,
    score: modelProbability(customer, modelType),
    label: customer.churned,
  }));
}

export interface Confusion {
  true_negative: number;
  false_positive: number;
  false_negative: number;
  true_positive: number;
}

export function confusionAt(samples: ScoredSample[], threshold: number): Confusion {
  const confusion: Confusion = {
    true_negative: 0,
    false_positive: 0,
    false_negative: 0,
    true_positive: 0,
  };
  for (const { score, label } of samples) {
    const predicted = score >= threshold ? 1 : 0;
    if (label === 1 && predicted === 1) confusion.true_positive += 1;
    else if (label === 1 && predicted === 0) confusion.false_negative += 1;
    else if (label === 0 && predicted === 1) confusion.false_positive += 1;
    else confusion.true_negative += 1;
  }
  return confusion;
}

/**
 * Metrics derived from the confusion matrix.
 *
 * Precision, recall and F1 are null rather than zero when a rate is
 * undefined, matching how the real service reports an absent denominator.
 */
export function metricsFrom(confusion: Confusion): {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  roc_auc: number;
} {
  const { true_negative: tn, false_positive: fp, false_negative: fn, true_positive: tp } = confusion;
  const total = tn + fp + fn + tp;
  const precision = fp + tp > 0 ? tp / (fp + tp) : 0;
  const recall = fn + tp > 0 ? tp / (fn + tp) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    accuracy: total > 0 ? (tn + tp) / total : 0,
    precision: round(precision, 4),
    recall: round(recall, 4),
    f1: round(f1, 4),
    roc_auc: 0,
  };
}

/**
 * Area under the ROC curve by the rank method.
 *
 * Equivalent to integrating the step curve, but O(n log n) rather than sorting
 * once per threshold. Ties are handled with the mid-rank correction, which
 * matters because a tree model produces many identical scores.
 */
export function rocAuc(samples: ScoredSample[]): number {
  const positives = samples.filter((s) => s.label === 1);
  const negatives = samples.filter((s) => s.label === 0);
  if (positives.length === 0 || negatives.length === 0) return 0;

  const sorted = [...samples].sort((a, b) => a.score - b.score);
  let rank = 1;
  let positiveRankSum = 0;
  while (rank <= sorted.length) {
    let end = rank;
    while (end < sorted.length && sorted[end]!.score === sorted[rank - 1]!.score) {
      end += 1;
    }
    // The whole tie group shares the average of the ranks it spans.
    const midRank = (rank + end) / 2;
    for (let index = rank - 1; index < end; index += 1) {
      if (sorted[index]!.label === 1) positiveRankSum += midRank;
    }
    rank = end + 1;
  }

  const auc =
    (positiveRankSum - (positives.length * (positives.length + 1)) / 2) /
    (positives.length * negatives.length);
  return round(Math.min(Math.max(auc, 0), 1), 4);
}

/**
 * The ROC curve, thinned to a fixed number of points.
 *
 * A 7,043-point curve is unreadable on a page and slow to render, so the
 * standard points (the two corners, plus evenly spaced thresholds) are kept.
 */
export function rocCurve(
  samples: ScoredSample[],
  pointCount = 40,
): { points: { fpr: number; tpr: number; threshold: number }[]; auc: number } {
  const sorted = [...samples].sort((a, b) => b.score - a.score);
  const positives = samples.filter((s) => s.label === 1).length;
  const negatives = samples.length - positives;
  if (positives === 0 || negatives === 0) {
    return { points: [{ fpr: 0, tpr: 0, threshold: 1 }], auc: 0 };
  }

  const points: { fpr: number; tpr: number; threshold: number }[] = [
    { fpr: 0, tpr: 0, threshold: 1 },
  ];
  let truePositives = 0;
  let falsePositives = 0;
  const stride = Math.max(1, Math.floor(sorted.length / pointCount));
  let emitted = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index]!.label === 1) truePositives += 1;
    else falsePositives += 1;
    emitted += 1;
    if (emitted < stride) continue;
    emitted = 0;
    points.push({
      fpr: round(falsePositives / negatives, 4),
      tpr: round(truePositives / positives, 4),
      threshold: round(sorted[index]!.score, 4),
    });
  }
  points.push({ fpr: 1, tpr: 1, threshold: 0 });
  return { points, auc: rocAuc(samples) };
}

/**
 * Decile lift: the realised churn rate in each band of predicted risk, against
 * the overall rate. Decile one is the highest-risk tenth.
 *
 * The shape matches what the service reports, so the lift table on the model
 * page needs no adaptation.
 */
export function decileLift(samples: ScoredSample[]): {
  deciles: number;
  baseline_churn_rate: number;
  rows: {
    decile: number;
    customers: number;
    churners: number;
    churn_rate: number;
    lift: number;
    cumulative_captured: number;
  }[];
} {
  const overall =
    samples.reduce((sum, sample) => sum + sample.label, 0) / samples.length;
  const sorted = [...samples].sort((a, b) => b.score - a.score);
  const size = Math.floor(sorted.length / 10);
  const rows: {
    decile: number;
    customers: number;
    churners: number;
    churn_rate: number;
    lift: number;
    cumulative_captured: number;
  }[] = [];
  let captured = 0;

  for (let decile = 0; decile < 10; decile += 1) {
    const start = decile * size;
    const slice = sorted.slice(start, decile === 9 ? sorted.length : start + size);
    if (slice.length === 0) continue;
    const churners = slice.reduce((sum, sample) => sum + sample.label, 0);
    captured += churners;
    const churnRate = churners / slice.length;
    rows.push({
      decile: decile + 1,
      customers: slice.length,
      churners,
      churn_rate: round(churnRate, 4),
      lift: round(churnRate / overall, 4),
      cumulative_captured: round(captured / sorted.length, 4),
    });
  }
  return { deciles: rows.length, baseline_churn_rate: round(overall, 4), rows };
}

/** One complete evaluation of a sample, exactly as the pages consume it. */
export function evaluate(
  samples: ScoredSample[],
  split: "validation_cv" | "test",
  threshold: number,
  evaluatedAt: string,
): {
  split: "validation_cv" | "test";
  sample_size: number;
  positive_count: number;
  metrics: ReturnType<typeof metricsFrom> | null;
  confusion_matrix: Confusion | null;
  roc: ReturnType<typeof rocCurve> | null;
  threshold: number;
  evaluated_at: string;
  notes: string[];
} {
  const confusion = confusionAt(samples, threshold);
  const metrics = metricsFrom(confusion);
  metrics.roc_auc = rocAuc(samples);
  return {
    split,
    sample_size: samples.length,
    positive_count: samples.filter((sample) => sample.label === 1).length,
    metrics,
    confusion_matrix: confusion,
    roc: rocCurve(samples),
    threshold,
    evaluated_at: evaluatedAt,
    notes:
      split === "validation_cv"
        ? ["Scored by mean AUC-ROC across stratified cross-validation folds."]
        : [
            "Scored once on the held-out test split, which took no part in model selection.",
            "Validation and test figures are reported separately and never pooled.",
          ],
  };
}

/**
 * Stratified split, so both sides keep the same churn rate.
 *
 * Each class is shuffled separately and the test set is taken from the head of
 * both, which holds the class ratio on both sides to within one row.
 */
export function stratifiedSplit(
  samples: ScoredSample[],
  testFraction: number,
  seed: string,
): { train: ScoredSample[]; test: ScoredSample[] } {
  const rng = new Rng(seed);
  const churners = rng.sample(
    samples.filter((s) => s.label === 1),
    samples.length,
  );
  const stayers = rng.sample(
    samples.filter((s) => s.label === 0),
    samples.length,
  );

  const testSize = Math.round(samples.length * testFraction);
  const churnRate = churners.length / samples.length;
  // Largest remainder, so the two halves always add back to the test size.
  const testChurners = Math.floor(testSize * churnRate);
  const testStayers = testSize - testChurners;

  return {
    test: [...churners.slice(0, testChurners), ...stayers.slice(0, testStayers)],
    train: [...churners.slice(testChurners), ...stayers.slice(testStayers)],
  };
}
