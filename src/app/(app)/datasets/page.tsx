import type { Metadata } from "next";
import Link from "next/link";
import { UploadDatasetForm } from "@/components/datasets/upload-form";
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
import { listDatasets } from "@/lib/dal/datasets";
import { env } from "@/lib/env";
import { formatBytes, formatDate, formatPercent, formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Datasets" };
export const dynamic = "force-dynamic";

/**
 * The dataset list and the upload form.
 *
 * This is the start of the workflow: everything downstream needs a validated
 * dataset, so the empty state points at uploading rather than describing the
 * platform.
 */
export default async function DatasetsPage() {
  const datasets = await listDatasets();
  const validated = datasets.filter((d) => d.status === "validated" || d.status === "preprocessed" || d.status === "ready");
  const withErrors = datasets.filter((d) => d.errorCount && d.errorCount > 0);

  return (
    <>
      <PageHeader
        title="Datasets"
        description="Upload a churn dataset and check what is in it. Everything downstream — training, predictions, explanations — depends on a dataset that has passed validation."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section title="Upload a dataset">
          <Card>
            <CardBody>
              <UploadDatasetForm maxBytes={env.maxUploadBytes} />
            </CardBody>
          </Card>
        </Section>

        <Section
          title="Uploaded datasets"
          description={
            datasets.length > 0
              ? `${datasets.length} dataset${datasets.length === 1 ? "" : "s"}, most recent first.`
              : undefined
          }
        >
          <Card>
            {datasets.length === 0 ? (
              <EmptyState
                title="No datasets yet"
                description={
                  <>
                    Nothing has been uploaded. The platform measures every
                    dataset it is given: row and column counts, missing values,
                    duplicates, and whether the churn target is usable. Nothing
                    about any particular dataset is assumed.
                  </>
                }
              />
            ) : (
              <>
                {withErrors.length > 0 ? (
                  <div className="border-b border-line bg-critical-soft px-4 py-2.5 text-sm text-ink">
                    <span className="font-semibold text-critical">
                      {withErrors.length} dataset{withErrors.length === 1 ? "" : "s"}{" "}
                      {withErrors.length === 1 ? "has" : "have"} validation errors
                    </span>{" "}
                    and cannot be preprocessed until they are fixed.
                  </div>
                ) : null}
                <Table>
                  <thead>
                    <tr>
                      <Th>Name</Th>
                      <Th>Status</Th>
                      <Th align="right">Rows</Th>
                      <Th align="right">Churn rate</Th>
                      <Th align="right">Uploaded</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {datasets.map((dataset) => (
                      <Tr key={dataset.id}>
                        <Td>
                          <Link
                            href={`/datasets/${dataset.id}`}
                            className="font-medium text-action underline-offset-2 hover:underline"
                          >
                            {dataset.name}
                          </Link>
                          <p className="text-2xs text-ink-subtle">
                            {dataset.originalFilename} ·{" "}
                            {formatBytes(dataset.sizeBytes)}
                            {dataset.columnCount
                              ? ` · ${dataset.columnCount} columns`
                              : ""}
                          </p>
                        </Td>
                        <Td>
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge status={dataset.status} />
                            {dataset.errorCount ? (
                              <span className="text-2xs text-critical">
                                {dataset.errorCount} error
                                {dataset.errorCount === 1 ? "" : "s"}
                              </span>
                            ) : dataset.warningCount ? (
                              <span className="text-2xs text-caution">
                                {dataset.warningCount} warning
                                {dataset.warningCount === 1 ? "" : "s"}
                              </span>
                            ) : null}
                          </div>
                        </Td>
                        <Td align="right">
                          {dataset.rowCount !== null
                            ? dataset.rowCount.toLocaleString()
                            : "—"}
                        </Td>
                        <Td align="right">
                          {dataset.targetPositiveRate !== null
                            ? formatPercent(dataset.targetPositiveRate, 2)
                            : "—"}
                        </Td>
                        <Td align="right" className="text-xs text-ink-subtle">
                          {formatRelative(dataset.createdAt)}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </Card>

          {datasets.length > 0 ? (
            <div className="mt-4">
              <Card>
                <CardHeader
                  title="What happens next"
                  description="The workflow runs in one direction. Each step depends on the one before it."
                />
                <CardBody>
                  <ol className="space-y-2 text-sm text-ink-muted">
                    {[
                      {
                        done: validated.length > 0,
                        text: "Upload a dataset and read its validation report",
                        href: "/datasets",
                      },
                      {
                        done: datasets.some((d) =>
                          ["preprocessed", "training", "ready"].includes(d.status),
                        ),
                        text: "Run the documented preprocessing",
                        href: datasets[0] ? `/datasets/${datasets[0].id}/preprocessing` : "/datasets",
                      },
                      {
                        done: false,
                        text: "Train and compare models",
                        href: "/training",
                      },
                      {
                        done: false,
                        text: "Activate a model and generate predictions",
                        href: "/models",
                      },
                    ].map((step, index) => (
                      <li key={step.text} className="flex gap-2.5">
                        <span
                          aria-hidden="true"
                          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-2xs font-semibold ${
                            step.done
                              ? "bg-positive text-white"
                              : "bg-surface-sunken text-ink-subtle"
                          }`}
                        >
                          {step.done ? "✓" : index + 1}
                        </span>
                        <span className={step.done ? "text-ink" : undefined}>
                          {step.done ? (
                            step.text
                          ) : (
                            <Link
                              href={step.href}
                              className="text-action underline underline-offset-2 hover:text-action-hover"
                            >
                              {step.text}
                            </Link>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
                    Last upload {formatDate(datasets[0]?.createdAt)}.
                  </p>
                </CardBody>
              </Card>
            </div>
          ) : null}
        </Section>
      </div>

      {datasets.length > 0 ? (
        <p className="mt-2 text-sm">
          <ButtonLink href="/training" size="sm">
            Go to training
          </ButtonLink>
        </p>
      ) : null}
    </>
  );
}
