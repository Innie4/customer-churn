import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PreprocessForm } from "@/components/datasets/preprocess-form";
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
  Section,
  Stat,
  StatGrid,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import {
  getDataset,
  getDatasetValidation,
  getPreprocessingRun,
  isUuid,
  latestPreprocessingRun,
} from "@/lib/dal/datasets";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Preprocessing" };
export const dynamic = "force-dynamic";

/**
 * Run and inspect preprocessing.
 *
 * The form exposes the documented settings; the report below shows exactly what
 * the last run did, step by step, so the process is reproducible rather than
 * something that happened behind a button.
 */
export default async function PreprocessingPage({
  params,
}: PageProps<"/datasets/[id]/preprocessing">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const [dataset, validation, latestRun] = await Promise.all([
    getDataset(id),
    getDatasetValidation(id),
    latestPreprocessingRun(id),
  ]);
  if (!dataset) notFound();

  const errors = validation?.error_count ?? 0;
  const history = await Promise.all(
    dataset.preprocessingRuns.map((run) => getPreprocessingRun(run.id)),
  );

  return (
    <>
      <PageHeader
        title="Preprocessing"
        description={`${dataset.name} — the documented data preparation workflow, with every step recorded.`}
        breadcrumb={
          <Link
            href={`/datasets/${id}`}
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← {dataset.name}
          </Link>
        }
        actions={
          <>
            <ButtonLink href={`/datasets/${id}/preview`} size="sm">
              Preview data
            </ButtonLink>
            {latestRun ? (
              <ButtonLink href="/training" size="sm" variant="primary">
                Continue to training
              </ButtonLink>
            ) : null}
          </>
        }
      />

      {errors > 0 ? (
        <div className="mb-6">
          <ErrorState
            title="Preprocessing is blocked"
            message={`This dataset has ${errors} validation error${
              errors === 1 ? "" : "s"
            }.`}
            nextAction="Fix the source file and upload it again. Preprocessing will not run on a dataset whose structure is known to be wrong."
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section title="Run preprocessing">
          <Card>
            <CardBody>
              {errors > 0 ? (
                <EmptyState
                  title="Blocked by validation errors"
                  description="The documented workflow assumes the columns it needs are present and the target is usable. Running it on a file that fails validation would produce a model nobody should trust."
                  action={
                    <ButtonLink
                      href={`/datasets/${id}/validation`}
                      variant="primary"
                      size="sm"
                    >
                      Read the validation report
                    </ButtonLink>
                  }
                />
              ) : (
                <PreprocessForm
                  datasetId={id}
                  targetColumn={dataset.targetColumn ?? ""}
                  candidateIdColumns={dataset.columns
                    .filter((column) => column.inferredType === "text" || column.distinctCount === dataset.rowCount)
                    .map((column) => column.name)
                    .slice(0, 5)}
                  rowCount={dataset.rowCount}
                />
              )}
            </CardBody>
          </Card>

          <div className="mt-4">
            <Card>
              <CardHeader
                title="What this step does"
                description="The methodology the platform implements, in order."
              />
              <CardBody>
                <ol className="space-y-2.5 text-sm text-ink-muted">
                  {[
                    "Convert TotalCharges to a number, setting blanks to 0.0 for zero-tenure customers who have not yet been billed.",
                    "Trim categorical values and fold Yes/No spelling variants onto one form.",
                    "Binary-encode two-category columns; one-hot encode multi-category columns, keeping every level.",
                    "Standardise tenure, MonthlyCharges and TotalCharges, fitted on the training split only.",
                    "Split 80:20, stratified on the churn target.",
                    "Apply SMOTE to the training split only, refitted inside every cross-validation fold. The test split is never resampled.",
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
              </CardBody>
            </Card>
          </div>
        </Section>

        <Section
          title="Last run"
          description={
            latestRun
              ? `${formatDate(latestRun.createdAt, "full")}`
              : "Nothing has been run yet."
          }
        >
          {!latestRun ? (
            <Card>
              <EmptyState
                title="No preprocessing run yet"
                description="Run preprocessing to convert the columns, split the data, and balance the training split. Training cannot start until this completes."
              />
            </Card>
          ) : (
            <PreprocessReport run={latestRun} />
          )}
        </Section>
      </div>

      {history.filter(Boolean).length > 1 ? (
        <Section title="Run history">
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Started</Th>
                  <Th>Status</Th>
                  <Th align="right">Features</Th>
                  <Th align="right">Warnings</Th>
                  <Th>Outcome</Th>
                </tr>
              </thead>
              <tbody>
                {history.filter(Boolean).map((run) => (
                  <Tr key={run!.id}>
                    <Td className="text-xs">{formatDate(run!.createdAt, "full")}</Td>
                    <Td>
                      <StatusBadge status={run!.status} />
                    </Td>
                    <Td align="right">
                      {run!.encodedFeatureCount ?? "—"}
                    </Td>
                    <Td align="right">{run!.warnings.length}</Td>
                    <Td className="text-xs text-ink-muted">
                      {run!.error ? (
                        <span className="text-critical">{run!.error}</span>
                      ) : run!.status === "completed" ? (
                        `${formatNumber(
                          (run!.split as { train_rows?: number } | null)?.train_rows ??
                            null,
                        )} training rows`
                      ) : (
                        "—"
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </Section>
      ) : null}
    </>
  );
}

function PreprocessReport({
  run,
}: {
  run: NonNullable<Awaited<ReturnType<typeof getPreprocessingRun>>>;
}) {
  if (run.status === "failed") {
    return (
      <Card>
        <CardBody>
          <ErrorState
            title="The last preprocessing run failed"
            message={run.error ?? "No reason was recorded."}
            detail={run.errorStage ? `Failed stage: ${run.errorStage}` : undefined}
            nextAction="Check the machine learning service is running and reachable, then run preprocessing again. The failed run is kept so the history shows what happened."
          />
        </CardBody>
      </Card>
    );
  }

  const split = run.split as
    | {
        train_rows: number;
        test_rows: number;
        train_churn_rate: number;
        test_churn_rate: number;
        stratified: boolean;
      }
    | null;
  const resample = run.resample as
    | { applied: boolean; method: string | null; rows_before: number | null; rows_after: number | null; note: string }
    | null;

  return (
    <div className="space-y-6">
      <Card>
        <StatGrid>
          <Stat
            label="Training rows"
            value={split ? formatNumber(split.train_rows) : "—"}
            hint={split?.stratified ? "Stratified on the target" : undefined}
          />
          <Stat label="Test rows" value={split ? formatNumber(split.test_rows) : "—"} />
          <Stat
            label="Encoded features"
            value={run.encodedFeatureCount ?? "—"}
            hint="Model input columns"
          />
          <Stat
            label="SMOTE"
            value={resample?.applied ? "Applied" : "Skipped"}
            tone={resample?.applied ? "info" : "neutral"}
            hint={resample?.applied ? "Training split only" : undefined}
          />
        </StatGrid>
      </Card>

      {split ? (
        <Card>
          <CardHeader
            title="Class balance"
            description="Stratification keeps the churn rate the same in both splits, so the test split reflects the real class distribution."
          />
          <CardBody>
            <DetailList>
              <Detail label="Training churn rate">
                {formatPercent(Number(split.train_churn_rate), 2)}
              </Detail>
              <Detail label="Test churn rate">
                {formatPercent(Number(split.test_churn_rate), 2)}
              </Detail>
              <Detail label="Stratified">{split.stratified ? "Yes" : "No"}</Detail>
              <Detail label="Random seed">
                {(run.params as { random_seed?: number }).random_seed ?? "—"}
              </Detail>
            </DetailList>
            {resample ? (
              <div className="mt-4">
                <Notice tone="info" title={resample.method ?? "Resampling"}>
                  {resample.rows_before !== null && resample.rows_after !== null
                    ? `${formatNumber(resample.rows_before)} rows became ${formatNumber(
                        resample.rows_after,
                      )}. `
                    : ""}
                  {resample.note}
                </Notice>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {Object.keys(run.scalerMean).length > 0 ? (
        <Card>
          <CardHeader
            title="Standardisation"
            description="Fitted on the training split only, so no test-set statistic reached the transform."
          />
          <CardBody>
            <Table>
              <thead>
                <tr>
                  <Th>Column</Th>
                  <Th align="right">Training mean</Th>
                  <Th align="right">Training std</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(run.scalerMean).map(([column, mean]) => (
                  <Tr key={column}>
                    <Td>{column}</Td>
                    <Td align="right">{Number(mean).toFixed(3)}</Td>
                    <Td align="right">
                      {Number(run.scalerScale[column] ?? 0).toFixed(3)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Steps performed"
          description="In the order they ran, with the row counts at each stage."
        />
        <CardBody>
          <ol className="space-y-4">
            {run.steps.map((step, index) => {
              const details = step as {
                step: string;
                description: string;
                rows_in: number;
                rows_out: number;
                affected_columns?: string[];
                warnings?: string[];
              };
              return (
                <li key={`${details.step}-${index}`} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xs font-semibold text-ink-subtle"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {details.step.replace(/_/g, " ")}
                    </p>
                    <p className="mt-0.5 text-sm text-ink-muted">
                      {details.description}
                    </p>
                    <p className="mt-1 text-2xs text-ink-subtle">
                      {formatNumber(details.rows_in)} →{" "}
                      {formatNumber(details.rows_out)} rows
                      {details.affected_columns && details.affected_columns.length > 0
                        ? ` · ${details.affected_columns.length} column(s) affected`
                        : ""}
                    </p>
                    {details.warnings && details.warnings.length > 0 ? (
                      <ul className="mt-1.5 space-y-1">
                        {details.warnings.map((warning) => (
                          <li key={warning} className="text-2xs text-caution">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </CardBody>
      </Card>

      {run.warnings.length > 0 ? (
        <Notice tone="caution" title={`${run.warnings.length} warning(s) from this run`}>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {run.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}
