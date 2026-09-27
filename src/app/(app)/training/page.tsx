import type { Metadata } from "next";
import Link from "next/link";
import { StartTrainingForm } from "@/components/models/start-training-form";
import {
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Section,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { requireActor } from "@/lib/dal/access";
import { listDatasets, latestPreprocessingRun } from "@/lib/dal/datasets";
import { listModelRuns } from "@/lib/dal/models";
import { getMlSettings } from "@/lib/dal/settings";
import { formatDate, formatDuration, formatNumber, formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Training" };
export const dynamic = "force-dynamic";

interface TrainableDataset {
  id: string;
  name: string;
  rowCount: number | null;
  preprocessed: boolean;
  runId: string;
}

/**
 * Training.
 *
 * The three model families are compared under identical conditions, so the
 * comparison is fair. Nothing is presented as "best" here: activation is a
 * separate, human decision made after reading the measured metrics.
 */
export default async function TrainingPage() {
  await requireActor();
  const [runs, settings] = await Promise.all([listModelRuns(25), getMlSettings()]);
  const datasets = await listDatasets();

  // A dataset is trainable once preprocessing has completed on it.
  const trainable: TrainableDataset[] = await Promise.all(
    datasets.map(async (dataset) => {
      const run = await latestPreprocessingRun(dataset.id);
      return {
        id: dataset.id,
        name: dataset.name,
        rowCount: dataset.rowCount,
        preprocessed: run !== null,
        // Non-null because only preprocessed datasets reach this list.
        runId: run?.id ?? "",
      };
    }),
  );
  const ready = trainable.filter((dataset) => dataset.preprocessed && dataset.runId);

  return (
    <>
      <PageHeader
        title="Training"
        description="Train and compare the three model families on the same data, with the same split and the same scoring metric."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section title="Start a training run">
          <Card>
            <CardBody>
              {ready.length === 0 ? (
                <EmptyState
                  title="No preprocessed dataset yet"
                  description="Training needs a dataset that has been validated and preprocessed. Complete that first, then come back here."
                  action={
                    <ButtonLink href="/datasets" variant="primary" size="sm">
                      Go to datasets
                    </ButtonLink>
                  }
                />
              ) : (
                <StartTrainingForm
                  datasets={ready}
                  defaultFolds={settings.cvFolds}
                  defaultSeed={settings.randomSeed}
                  defaultModelTypes={settings.defaultModelTypes}
                />
              )}
            </CardBody>
          </Card>

          <div className="mt-4">
            <Card>
              <CardHeader
                title="How a run works"
                description="Every model sees identical data, so the comparison is fair."
              />
              <CardBody>
                <ol className="space-y-2.5 text-sm text-ink-muted">
                  {[
                    "Each requested model is tuned by grid search, scored on AUC-ROC over stratified cross-validation folds inside the training split.",
                    "The best configuration is refitted on the whole training split.",
                    "It is then evaluated once on the held-out test split, which took no part in tuning.",
                    "Metrics, confusion matrix, ROC curve and decile lift are stored with the model.",
                  ].map((text, index) => (
                    <li key={text} className="flex gap-2.5">
                      <span
                        aria-hidden="true"
                        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xs font-semibold text-ink-subtle"
                      >
                        {index + 1}
                      </span>
                      <span>{text}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
                  Because SMOTE has already balanced the training split, the
                  cross-validation figures run higher than the test figures.
                  Both are reported separately so the difference is visible.
                </p>
              </CardBody>
            </Card>
          </div>
        </Section>

        <Section
          title="Training history"
          description={
            runs.length > 0
              ? "Every run, including the ones that failed. A history that hides failures is not a history."
              : undefined
          }
        >
          <Card>
            {runs.length === 0 ? (
              <EmptyState
                title="No training runs yet"
                description="Start a run and its progress, metrics and outcome will appear here."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Run</Th>
                    <Th>Status</Th>
                    <Th align="right">Models</Th>
                    <Th align="right">Duration</Th>
                    <Th align="right">Started</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <Tr key={run.id}>
                      <Td>
                        <Link
                          href={`/training/${run.id}`}
                          className="font-medium text-action underline-offset-2 hover:underline"
                        >
                          {run.label ?? `Run ${run.id.slice(0, 8)}`}
                        </Link>
                        <p className="text-2xs text-ink-subtle">
                          {run.datasetName ?? "dataset removed"} · {run.cvFolds}-fold
                        </p>
                        {run.status === "running" || run.status === "queued" ? (
                          <p className="mt-1 text-2xs text-info">
                            {run.stage} ({run.progressPercent}%)
                          </p>
                        ) : null}
                        {run.error ? (
                          <p className="mt-1 text-2xs text-critical">
                            {run.errorStage ? `${run.errorStage}: ` : ""}
                            {run.error}
                          </p>
                        ) : null}
                      </Td>
                      <Td>
                        <StatusBadge status={run.status} />
                      </Td>
                      <Td align="right">
                        <span className="text-ink">{run.completedCount}</span>
                        {run.failedCount > 0 ? (
                          <span className="text-critical"> / {run.failedCount} failed</span>
                        ) : (
                          <span className="text-ink-subtle"> of {run.modelCount}</span>
                        )}
                      </Td>
                      <Td align="right" className="text-xs text-ink-muted">
                        {formatDuration(run.durationSeconds)}
                      </Td>
                      <Td align="right" className="text-xs text-ink-subtle">
                        {run.startedAt ? formatRelative(run.startedAt) : "—"}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {runs.length > 0 ? (
            <p className="mt-3 text-xs text-ink-subtle">
              Total runs: {formatNumber(runs.length)}. Completed{" "}
              {formatNumber(runs.filter((r) => r.status === "completed").length)},
              failed {formatNumber(runs.filter((r) => r.status === "failed").length)}.
              {" "}
              {runs[0]?.startedAt
                ? `Most recent started ${formatDate(runs[0].startedAt, "full")}.`
                : null}
            </p>
          ) : null}
        </Section>
      </div>
    </>
  );
}
