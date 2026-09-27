import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TrainingRunLive } from "@/components/models/training-run-live";
import { MetricsTable, ConfusionMatrixView, DecileLiftTable } from "@/components/models/metrics";
import {
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Detail,
  DetailList,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  Progress,
  Section,
  StatusBadge,
} from "@/components/ui";
import { isUuid } from "@/lib/dal/datasets";
import { getModelRun, listModelsForRun, syncModelRun } from "@/lib/dal/models";
import { formatDate, formatDuration } from "@/lib/format";

export const metadata: Metadata = { title: "Training run" };
export const dynamic = "force-dynamic";

/**
 * One training run.
 *
 * Reconciles with the machine learning service on load, so the progress and
 * metrics shown are current rather than as of the last poll. A run that failed
 * keeps its error and its stage, because that is what the history needs.
 */
export default async function TrainingRunPage({
  params,
}: PageProps<"/training/[id]">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  let run = await getModelRun(id);
  if (!run) notFound();

  // Bring the row into line with the service before rendering.
  if (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "evaluating"
  ) {
    run = await syncModelRun(id);
  }

  const inFlight = ["queued", "running", "evaluating"].includes(run.status);
  const models = await listModelsForRun(id);

  return (
    <>
      <PageHeader
        title={run.label ?? `Training run ${run.id.slice(0, 8)}`}
        description={
          <>
            {run.datasetName ?? "Dataset removed"} · {run.cvFolds}-fold stratified
            cross-validation · seed {run.randomSeed}
            {run.startedByName ? ` · started by ${run.startedByName}` : ""}
          </>
        }
        breadcrumb={
          <Link
            href="/training"
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← Training
          </Link>
        }
        actions={
          <>
            <StatusBadge status={run.status} />
            {models.some((model) => model.status === "completed") ? (
              <ButtonLink href="/models" size="sm" variant="primary">
                Compare models
              </ButtonLink>
            ) : null}
          </>
        }
      />

      {inFlight ? (
        <div className="mb-6">
          <Card>
            <CardBody>
              <Progress value={run.progressPercent} label={run.stage} />
              <p className="mt-3 text-xs text-ink-subtle">
                This page follows the run while it is in flight. Training happens
                on the machine learning service, so you can navigate away and
                come back — the outcome is recorded either way.
              </p>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {run.status === "failed" ? (
        <div className="mb-6">
          <ErrorState
            title="Training failed"
            message={run.error ?? "No reason was recorded."}
            detail={
              run.errorStage
                ? `Failed stage: ${run.errorStage}`
                : "The stage could not be identified."
            }
            nextAction="Check the machine learning service is running and that the dataset still preprocesses cleanly, then start a new run. This run is kept in the history."
          />
        </div>
      ) : null}

      <Section title="Run">
        <Card>
          <CardBody>
            <DetailList columns={3}>
              <Detail label="Status">{run.status}</Detail>
              <Detail label="Started">
                {run.startedAt ? formatDate(run.startedAt, "full") : "Not started"}
              </Detail>
              <Detail label="Finished">
                {run.finishedAt ? formatDate(run.finishedAt, "full") : "—"}
              </Detail>
              <Detail label="Duration">
                {formatDuration(run.durationSeconds)}
              </Detail>
              <Detail label="Requested models">
                {run.requestedModels.map((type) => type.replace(/_/g, " ")).join(", ")}
              </Detail>
              <Detail label="Models completed">
                {run.completedCount} of {run.modelCount}
                {run.failedCount > 0 ? `, ${run.failedCount} failed` : ""}
              </Detail>
            </DetailList>
          </CardBody>
        </Card>
      </Section>

      {models.length === 0 ? (
        <Section title="Models">
          <Card>
            <EmptyState
              title={inFlight ? "Training in progress" : "No models were produced"}
              description={
                inFlight
                  ? "Results appear here as each model finishes. Nothing is shown until it has actually been measured."
                  : "This run produced no models. The reason, if there was one, is recorded above."
              }
            />
          </Card>
        </Section>
      ) : (
        <>
          <Section
            title="Comparison"
            description="Test-set metrics, measured once on the held-out split each model never saw."
            actions={
              <ButtonLink href={`/training/${id}/performance`} size="sm">
                Full performance detail
              </ButtonLink>
            }
          >
            <MetricsTable models={models} />
          </Section>

          {models
            .filter((model) => model.status === "completed")
            .map((model) => (
              <Section
                key={model.id}
                title={model.displayName}
                description={
                  model.status === "completed"
                    ? `Version ${model.version ?? "unknown"} · ${
                        model.isActive ? "active for predictions" : "not active"
                      }`
                    : undefined
                }
                actions={
                  model.status === "completed" ? (
                    <>
                      <ButtonLink href={`/models/${model.id}`} size="sm">
                        Model detail
                      </ButtonLink>
                      <ButtonLink
                        href={`/models/${model.id}/explanations`}
                        size="sm"
                      >
                        Explanations
                      </ButtonLink>
                    </>
                  ) : null
                }
              >
                {model.status === "failed" ? (
                  <ErrorState
                    title={`${model.displayName} did not train`}
                    message={model.error ?? "No reason was recorded."}
                    detail={model.errorStage ? `Stage: ${model.errorStage}` : undefined}
                    nextAction="The other models in this run are unaffected. Start a new run to retry this one."
                  />
                ) : (
                  <div className="grid gap-6 lg:grid-cols-2">
                    <Card>
                      <CardHeader
                        title="Confusion matrix"
                        description="Measured on the test split. Missed churners are the number a retention team cares about."
                      />
                      <CardBody>
                        <ConfusionMatrixView confusion={model.testConfusion} />
                      </CardBody>
                    </Card>
                    {model.decileLift ? (
                      <Card>
                        <CardHeader
                          title="Decile lift"
                          description="Churn rate per tenth of the base, ranked by predicted risk."
                        />
                        <CardBody>
                          <DecileLiftTable lift={model.decileLift} />
                        </CardBody>
                      </Card>
                    ) : null}
                  </div>
                )}
              </Section>
            ))}
        </>
      )}

      {inFlight ? (
        <div className="mt-6">
          <TrainingRunLive runId={id} />
        </div>
      ) : null}

      {models.some((model) => model.status === "completed") ? (
        <Section title="Next step">
          <Card>
            <CardBody>
              <Notice tone="info" title="No model has been promoted automatically">
                Choosing which model serves predictions is a human decision.
                Read the measured metrics, decide which trade-off suits the
                business, then activate that model on its page. The choice and
                the reason are recorded in the audit trail.
              </Notice>
              <div className="mt-4 flex flex-wrap gap-2">
                <ButtonLink href="/models" variant="primary" size="sm">
                  Go to models
                </ButtonLink>
                <ButtonLink href={`/training/${id}/performance`} size="sm">
                  Full performance detail
                </ButtonLink>
              </div>
            </CardBody>
          </Card>
        </Section>
      ) : null}
    </>
  );
}

