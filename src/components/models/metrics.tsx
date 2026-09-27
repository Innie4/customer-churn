/**
 * Metric visualisations.
 *
 * Confusion matrix, decile lift and the model comparison table. Colour encodes
 * meaning here: red for missed churners, green for caught ones, amber where a
 * decile performs at or below the base rate.
 */

import {
  Bar,
  Card,
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from "@/components/ui";
import { formatNumber, formatPercent } from "@/lib/format";

export interface ComparisonModel {
  id: string;
  displayName: string;
  status: string;
  isActive: boolean;
  cvScore: number | null;
  testMetrics: Record<string, number> | null;
}

const METRIC_ROWS = [
  { key: "accuracy", label: "Accuracy" },
  { key: "precision", label: "Precision" },
  { key: "recall", label: "Recall" },
  { key: "f1", label: "F1-score" },
  { key: "roc_auc", label: "AUC-ROC" },
] as const;

/**
 * The side-by-side comparison.
 *
 * The best value in each row is marked, but no overall winner is declared. A
 * model that leads on recall and one that leads on precision are making
 * different trade-offs, and collapsing that into a single ranking would hide
 * exactly what a reader needs to see.
 */
export function MetricsTable({ models }: { models: ComparisonModel[] }) {
  const completed = models.filter((model) => model.status === "completed");

  if (completed.length === 0) {
    return (
      <Card>
        <p className="px-4 py-6 text-sm text-ink-muted">
          No model has finished training, so there are no measured metrics to
          compare. Figures appear only after a model has actually been
          evaluated on the test split.
        </p>
      </Card>
    );
  }

  const bestByMetric = new Map<string, string>();
  for (const metric of METRIC_ROWS) {
    let bestId: string | null = null;
    let bestValue = -Infinity;
    for (const model of completed) {
      const value = model.testMetrics?.[metric.key];
      if (value === undefined || value === null) continue;
      if (value > bestValue) {
        bestValue = value;
        bestId = model.id;
      }
    }
    if (bestId) bestByMetric.set(metric.key, bestId);
  }

  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Model</Th>
            {METRIC_ROWS.map((metric) => (
              <Th key={metric.key} align="right">
                {metric.label}
              </Th>
            ))}
            <Th align="right">CV AUC-ROC</Th>
            <Th align="center">Active</Th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            const failed = model.status === "failed";
            return (
              <Tr key={model.id} className={failed ? "opacity-60" : undefined}>
                <Td>
                  <span className="font-medium">{model.displayName}</span>
                  {failed ? (
                    <span className="ml-1.5 text-2xs text-critical">failed</span>
                  ) : null}
                </Td>
                {METRIC_ROWS.map((metric) => {
                  const value = model.testMetrics?.[metric.key];
                  const isBest = bestByMetric.get(metric.key) === model.id;
                  return (
                    <Td
                      key={metric.key}
                      align="right"
                      className={isBest ? "font-semibold text-ink" : "text-ink-muted"}
                    >
                      {value === undefined || value === null
                        ? "—"
                        : formatPercent(value, 1)}
                      {isBest ? (
                        <span
                          className="ml-1 text-2xs text-positive"
                          title="Highest in this column"
                        >
                          ▲
                        </span>
                      ) : null}
                    </Td>
                  );
                })}
                <Td align="right" className="text-ink-muted">
                  {model.cvScore !== null ? model.cvScore.toFixed(4) : "—"}
                </Td>
                <Td align="center">
                  {model.isActive ? (
                    <span className="text-2xs font-medium text-positive">Active</span>
                  ) : (
                    <span className="text-2xs text-ink-faint">—</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <div className="border-t border-line px-4 py-3">
        <p className="text-xs text-ink-subtle">
          ▲ marks the highest value in that column, not an overall winner. No
          model leads on every metric: recall and precision pull in opposite
          directions, and the right choice depends on what a missed churner costs
          against what a false alarm costs. Cross-validation figures run higher
          than test figures because the training split was SMOTE-balanced.
        </p>
      </div>
    </Card>
  );
}

export function ConfusionMatrixView({
  confusion,
}: {
  confusion: Record<string, number> | null;
}) {
  if (!confusion) {
    return <p className="text-sm text-ink-muted">No confusion matrix was recorded.</p>;
  }

  const tn = Number(confusion.true_negative ?? 0);
  const fp = Number(confusion.false_positive ?? 0);
  const fn = Number(confusion.false_negative ?? 0);
  const tp = Number(confusion.true_positive ?? 0);
  const total = tn + fp + fn + tp;

  const cells: {
    label: string;
    value: number;
    tone: Tone;
    note: string;
  }[] = [
    {
      label: "Kept, correctly",
      value: tn,
      tone: "positive",
      note: "Stayed, and was not flagged",
    },
    {
      label: "False alarm",
      value: fp,
      tone: "caution",
      note: "Stayed, but was flagged as at risk",
    },
    {
      label: "Missed churner",
      value: fn,
      tone: "critical",
      note: "Churned and was not flagged. This is the number that matters most.",
    },
    {
      label: "Caught churner",
      value: tp,
      tone: "positive",
      note: "Churned and was correctly flagged",
    },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className={`rounded-card border px-3 py-2.5 ${
              cell.tone === "critical"
                ? "border-critical-line bg-critical-soft"
                : cell.tone === "caution"
                  ? "border-caution-line bg-caution-soft"
                  : "border-line bg-surface"
            }`}
          >
            <p className="text-2xs tracking-wide text-ink-subtle uppercase">
              {cell.label}
            </p>
            <p
              className={`mt-0.5 text-xl font-semibold tabular ${
                cell.tone === "critical"
                  ? "text-critical"
                  : cell.tone === "caution"
                    ? "text-caution"
                    : "text-ink"
              }`}
            >
              {formatNumber(cell.value)}
            </p>
            <p className="mt-0.5 text-2xs text-ink-muted">
              {formatPercent(total > 0 ? cell.value / total : 0, 1)}
            </p>
            <p className="mt-1 text-2xs text-ink-subtle">{cell.note}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-subtle">
        {formatNumber(total)} customers in the test split.
      </p>
    </div>
  );
}

interface DecileRow {
  decile: number;
  customers: number;
  churners: number;
  churn_rate: number;
  lift: number;
  cumulative_captured: number;
}

export function DecileLiftTable({
  lift,
}: {
  lift: Record<string, unknown> | null;
}) {
  const rows = (lift?.rows as DecileRow[] | undefined) ?? [];
  const baseline = Number(lift?.baseline_churn_rate ?? 0);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No decile lift table was recorded for this model.
      </p>
    );
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Decile</Th>
            <Th align="right">Customers</Th>
            <Th align="right">Churners</Th>
            <Th align="right">Churn rate</Th>
            <Th align="right">Lift</Th>
            <Th align="right">Cumulative</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.decile}>
              <Td>
                {row.decile}
                {row.decile === 1 ? (
                  <span className="ml-1 text-2xs text-ink-subtle">
                    highest risk
                  </span>
                ) : null}
              </Td>
              <Td align="right">{formatNumber(row.customers)}</Td>
              <Td align="right">{formatNumber(row.churners)}</Td>
              <Td align="right">{formatPercent(row.churn_rate, 1)}</Td>
              <Td align="right">
                <span
                  className={row.lift >= 1 ? "font-medium text-critical" : "text-ink-muted"}
                >
                  {row.lift.toFixed(2)}x
                </span>
              </Td>
              <Td align="right" className="text-ink-muted">
                {formatPercent(row.cumulative_captured, 1)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <div className="mt-3 space-y-1">
        <Bar
          label={`Baseline churn rate across the test split`}
          value={baseline}
          max={Math.max(...rows.map((row) => row.churn_rate), baseline, 0.01)}
          display={formatPercent(baseline, 1)}
          tone="neutral"
        />
      </div>
      <p className="mt-2 text-xs text-ink-subtle">
        A lift above 1x means that decile contains churners at a higher rate than
        the base rate. This is the budget question: if the team can only contact
        the top slice of the base, how many real churners are in it?
      </p>
    </div>
  );
}
