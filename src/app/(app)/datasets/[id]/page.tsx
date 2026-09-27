import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Detail,
  DetailList,
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
import { getDataset, getDatasetValidation, isUuid } from "@/lib/dal/datasets";
import { formatBytes, formatDate, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Dataset" };
export const dynamic = "force-dynamic";

/**
 * A dataset's structure and its current state.
 *
 * Shows what was measured from the file, and offers the next step in the
 * workflow. If validation failed, the next step is fixing it, not training.
 */
export default async function DatasetPage({ params }: PageProps<"/datasets/[id]">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const dataset = await getDataset(id);
  if (!dataset) notFound();
  const validation = await getDatasetValidation(id);

  const errors = validation?.error_count ?? 0;
  const latestRun = dataset.preprocessingRuns[0];
  const canPreprocess = errors === 0;

  return (
    <>
      <PageHeader
        title={dataset.name}
        description={
          <>
            {dataset.originalFilename} · {formatBytes(dataset.sizeBytes)} · uploaded{" "}
            {formatDate(dataset.createdAt)}
            {dataset.uploadedByName ? ` by ${dataset.uploadedByName}` : ""}
          </>
        }
        breadcrumb={
          <Link
            href="/datasets"
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← All datasets
          </Link>
        }
        actions={
          <>
            <StatusBadge status={dataset.status} />
            <ButtonLink href={`/datasets/${id}/preview`} size="sm">
              Preview data
            </ButtonLink>
            <ButtonLink
              href={`/datasets/${id}/validation`}
              size="sm"
              variant={errors > 0 ? "primary" : "secondary"}
            >
              Validation report
            </ButtonLink>
            {canPreprocess ? (
              <ButtonLink href={`/datasets/${id}/preprocessing`} size="sm" variant="primary">
                Continue to preprocessing
              </ButtonLink>
            ) : null}
          </>
        }
      />

      {errors > 0 ? (
        <div className="mb-6">
          <ErrorState
            title="This dataset cannot be preprocessed yet"
            message={`Validation found ${errors} problem${errors === 1 ? "" : "s"} that must be fixed first.`}
            nextAction="Read the validation report for the specific findings, correct the source file, and upload it again."
          />
        </div>
      ) : null}

      <Section title="Measured from this file">
        <Card>
          <StatGrid>
            <Stat label="Rows" value={dataset.rowCount?.toLocaleString() ?? "—"} />
            <Stat label="Columns" value={dataset.columnCount ?? "—"} />
            <Stat
              label="Churn rate"
              value={
                dataset.targetPositiveRate !== null
                  ? formatPercent(dataset.targetPositiveRate, 2)
                  : "—"
              }
              hint={`Target: ${dataset.targetColumn ?? "not identified"}`}
            />
            <Stat
              label="Duplicate rows"
              value={dataset.duplicateRowCount?.toLocaleString() ?? "—"}
              tone={(dataset.duplicateRowCount ?? 0) > 0 ? "caution" : "neutral"}
            />
          </StatGrid>
        </Card>
      </Section>

      {dataset.targetDistribution && Object.keys(dataset.targetDistribution).length > 0 ? (
        <Section title="Target distribution">
          <Card>
            <CardBody>
              <ul className="space-y-2">
                {Object.entries(dataset.targetDistribution).map(([key, count]) => {
                  const total = Object.values(dataset.targetDistribution ?? {}).reduce(
                    (a, b) => a + b,
                    0,
                  );
                  return (
                    <li key={key} className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-sm text-ink">
                        {key === "yes" ? "Churned" : key === "no" ? "Stayed" : key}
                      </span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                        <span
                          className={`block h-full rounded-full ${
                            key === "yes" ? "bg-critical" : "bg-positive"
                          }`}
                          style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                        />
                      </span>
                      <span className="w-32 shrink-0 text-right text-sm tabular text-ink">
                        {count.toLocaleString()}{" "}
                        <span className="text-ink-subtle">
                          ({total > 0 ? formatPercent(count / total, 1) : "—"})
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
                Counted from the uploaded file. This is the natural class
                imbalance the preprocessing step has to address, not a target
                rate.
              </p>
            </CardBody>
          </Card>
        </Section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Columns">
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Column</Th>
                  <Th>Type</Th>
                  <Th align="right">Nulls</Th>
                  <Th align="right">Distinct</Th>
                </tr>
              </thead>
              <tbody>
                {dataset.columns.map((column) => (
                  <Tr key={column.id}>
                    <Td>
                      <span className="font-medium">{column.name}</span>
                      {column.isTarget ? (
                        <Badge tone="info" className="ml-1.5">
                          target
                        </Badge>
                      ) : null}
                      <p className="text-2xs text-ink-subtle">{column.pandasDtype}</p>
                    </Td>
                    <Td className="text-ink-muted">{column.inferredType}</Td>
                    <Td align="right">
                      {column.nullCount > 0 ? (
                        <span className="text-caution">
                          {column.nullCount.toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-ink-faint">0</span>
                      )}
                    </Td>
                    <Td align="right" className="text-ink-muted">
                      {column.distinctCount.toLocaleString()}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </Section>

        <Section title="File and preprocessing">
          <Card>
            <CardBody>
              <DetailList>
                <Detail label="File digest (SHA-256)">
                  <code className="font-mono text-2xs break-all text-ink-muted">
                    {dataset.sha256}
                  </code>
                  <p className="mt-1 text-2xs text-ink-subtle">
                    A model trained on this dataset is traceable to these exact
                    bytes.
                  </p>
                </Detail>
                <Detail label="Last updated">
                  {formatDate(dataset.updatedAt, "full")}
                </Detail>
                <Detail label="Preprocessing runs">
                  {dataset.preprocessingRuns.length === 0 ? (
                    <span className="text-ink-subtle">None yet</span>
                  ) : (
                    <ul className="space-y-1.5">
                      {dataset.preprocessingRuns.map((run) => (
                        <li key={run.id} className="flex items-center gap-2">
                          <StatusBadge status={run.status} />
                          <span className="text-2xs text-ink-subtle">
                            {run.encodedFeatureCount ?? "?"} features ·{" "}
                            {formatDate(run.createdAt, "short")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Detail>
              </DetailList>

              {latestRun?.status === "failed" ? (
                <div className="mt-4">
                  <ErrorState
                    title="The last preprocessing run failed"
                    message={latestRun.error ?? "No reason was recorded."}
                    nextAction="Check the machine learning service is running, then run preprocessing again."
                  />
                </div>
              ) : null}

              {latestRun && latestRun.status === "completed" ? (
                <div className="mt-4">
                  <Notice tone="positive" title="Preprocessing complete">
                    {latestRun.encodedFeatureCount} encoded features are ready
                    for training.
                    {latestRun.warnings.length > 0
                      ? ` ${latestRun.warnings.length} warning(s) were recorded.`
                      : ""}
                  </Notice>
                </div>
              ) : null}
            </CardBody>
          </Card>
        </Section>
      </div>

      <Section title="Next step">
        <Card>
          <CardHeader
            title={
              errors > 0
                ? "Fix the validation errors"
                : latestRun?.status === "completed"
                  ? "Train models on this dataset"
                  : "Run preprocessing"
            }
            description={
              errors > 0
                ? "Preprocessing refuses to run on a dataset with errors, so nothing downstream can be trusted until they are fixed."
                : latestRun?.status === "completed"
                  ? "Training compares three model families under identical conditions, then you choose which one to activate."
                  : "Preprocessing converts the columns, splits the data, and balances the training split. It has to run before training."
            }
            actions={
              errors > 0 ? (
                <ButtonLink href={`/datasets/${id}/validation`} variant="primary" size="sm">
                  Open validation report
                </ButtonLink>
              ) : latestRun?.status === "completed" ? (
                <ButtonLink href="/training" variant="primary" size="sm">
                  Go to training
                </ButtonLink>
              ) : (
                <ButtonLink href={`/datasets/${id}/preprocessing`} variant="primary" size="sm">
                  Run preprocessing
                </ButtonLink>
              )
            }
          />
        </Card>
      </Section>
    </>
  );
}
