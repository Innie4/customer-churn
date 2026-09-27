import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfusionMatrixView, DecileLiftTable } from "@/components/models/metrics";
import {
  ButtonLink,
  Card,
  CardBody,
  Detail,
  DetailList,
  EmptyState,
  Notice,
  PageHeader,
  Section,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { isUuid } from "@/lib/dal/datasets";
import {
  getModel,
  listModelCharts,
  ModelChartKind,
} from "@/lib/dal/models";
import { formatNumber, formatPercent } from "@/lib/format";

const CHART_TITLES: Record<ModelChartKind, string> = {
  [ModelChartKind.Confusion]: "Confusion matrix on the test split",
  [ModelChartKind.Roc]: "ROC curve",
  [ModelChartKind.Decile]: "Decile lift",
  [ModelChartKind.Beeswarm]: "SHAP value distribution across customers",
  [ModelChartKind.Importance]: "Mean absolute SHAP value by feature",
  [ModelChartKind.Waterfall]: "This customer's contributions",
};

export const metadata: Metadata = { title: "Model performance" };
export const dynamic = "force-dynamic";

/**
 * Full performance detail for one model.
 *
 * Validation and test figures are shown side by side and never blended. The gap
 * between them is a real and interesting result, not a defect to hide.
 */
export default async function ModelPerformancePage({
  params,
}: PageProps<"/models/[id]/performance">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const model = await getModel(id);
  if (!model) notFound();

  // Which charts exist is a cheap lookup; the bytes are only fetched if the
  // browser asks for them, so an unrendered chart costs nothing here.
  const charts = await listModelCharts(id);

  if (model.status !== "completed") {
    return (
      <>
        <PageHeader
          title="Model performance"
          breadcrumb={
            <Link
              href={`/models/${id}`}
              className="text-sm text-action underline-offset-2 hover:underline"
            >
              ← {model.displayName}
            </Link>
          }
        />
        <Card>
          <EmptyState
            title="This model has no performance figures"
            description={
              model.error
                ? `It did not finish training: ${model.error}`
                : "Training has not produced a result for this model yet."
            }
            action={
              <ButtonLink href="/training" variant="primary" size="sm">
                Go to training
              </ButtonLink>
            }
          />
        </Card>
      </>
    );
  }

  const grid = model.gridSearch as {
    cv_folds?: number;
    cv_strategy?: string;
    candidates_evaluated?: number;
    per_fold_scores?: number[];
    scoring_metric?: string;
  };

  return (
    <>
      <PageHeader
        title={`${model.displayName} performance`}
        description="Measured performance, with cross-validation and test results reported separately."
        breadcrumb={
          <Link
            href={`/models/${id}`}
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← {model.displayName}
          </Link>
        }
        actions={
          <ButtonLink href={`/models/${id}/explanations`} size="sm" variant="primary">
            View explanations
          </ButtonLink>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Cross-validation"
          description="Out-of-fold performance inside the training split. Higher than the test figures, because that split was SMOTE-balanced."
        >
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Metric</Th>
                  <Th align="right">Validation</Th>
                  <Th align="right">Test</Th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["accuracy", "Accuracy"],
                    ["precision", "Precision"],
                    ["recall", "Recall"],
                    ["f1", "F1-score"],
                    ["roc_auc", "AUC-ROC"],
                  ] as const
                ).map(([key, label]) => {
                  const validation = model.validationMetrics?.[key];
                  const test = model.testMetrics?.[key];
                  return (
                    <Tr key={key}>
                      <Td>{label}</Td>
                      <Td align="right" className="text-ink-muted">
                        {key === "roc_auc" || key === "f1"
                          ? validation !== undefined
                            ? validation.toFixed(4)
                            : "—"
                          : validation !== undefined
                            ? formatPercent(validation, 2)
                            : "—"}
                      </Td>
                      <Td align="right" className="font-medium">
                        {key === "roc_auc" || key === "f1"
                          ? test !== undefined
                            ? test.toFixed(4)
                            : "—"
                          : test !== undefined
                            ? formatPercent(test, 2)
                            : "—"}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <div className="border-t border-line px-4 py-3">
              <DetailList>
                <Detail label="Scoring metric">
                  {grid.scoring_metric ?? "roc_auc"}
                </Detail>
                <Detail label="Folds">
                  {grid.cv_folds ?? "—"} · {grid.cv_strategy ?? "—"}
                </Detail>
                <Detail label="Candidates evaluated">
                  {formatNumber(grid.candidates_evaluated ?? 0)}
                </Detail>
                <Detail label="Per-fold AUC-ROC">
                  {(grid.per_fold_scores ?? [])
                    .map((score) => score.toFixed(4))
                    .join(", ") || "—"}
                </Detail>
              </DetailList>
            </div>
            <div className="border-t border-line px-4 py-3">
              <p className="text-xs text-ink-muted">
                Cross-validation and test performance are not the same thing, and
                this platform does not average them into a single number. The
                test split is the only one that describes how the model behaves
                on customers it has never seen.
              </p>
            </div>
          </Card>
        </Section>

        <Section
          title="Test split"
          description="Measured once, on data the model never saw during training, resampling or tuning."
        >
          <Card>
            <CardBody>
              <ConfusionMatrixView confusion={model.testConfusion} />
            </CardBody>
          </Card>
        </Section>
      </div>

      <Section title="Decile lift on the test split">
        <Card>
          <CardBody>
            <DecileLiftTable lift={model.decileLift} />
          </CardBody>
        </Card>
      </Section>

      {charts.length > 0 ? (
        <Section
          title="Rendered charts"
          description="Drawn by the machine learning service from the measured results above. Nothing here is illustrative."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            {charts.map((kind) => (
              <Card key={kind}>
                <CardBody>
                  {/* The chart is streamed by an authenticated route, so it is
                      not a public asset and needs an unoptimised image. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/models/${model.id}/charts/${kind}`}
                    alt={CHART_TITLES[kind]}
                    className="w-full rounded border border-line bg-surface"
                    width={880}
                    height={528}
                  />
                  <p className="mt-2 text-xs text-ink-subtle">
                    {CHART_TITLES[kind]}
                  </p>
                </CardBody>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      {model.testNotes.length > 0 ? (
        <Section title="Notes on these figures">
          <Card>
            <CardBody>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-muted">
                {model.testNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </Section>
      ) : null}

      <Section title="What these numbers do and do not say">
        <Card>
          <CardBody>
            <Notice tone="caution" title="A ranking, not a certainty">
              These figures describe how well the model separated churners from
              non-churners on one held-out sample. They do not establish that a
              retention intervention will succeed, and a churn probability is not
              a prediction that a customer will certainly leave.
            </Notice>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-muted">
              <li>
                Accuracy alone is a poor guide for churn work: a model can score
                well by favouring the majority class, which is the larger one.
              </li>
              <li>
                Recall is usually the metric that matters most here. A missed
                churner is a customer the retention team never got the chance to
                save.
              </li>
              <li>
                Precision counts false alarms. A retention team contacted too
                often stops being contacted at all.
              </li>
              <li>
                Decile lift answers the budget question: if only part of the base
                can be contacted, how many real churners are in it?
              </li>
            </ul>
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
