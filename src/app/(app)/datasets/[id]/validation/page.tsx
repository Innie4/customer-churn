import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
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
import { RevalidateDatasetButton } from "@/components/datasets/revalidate-button";
import { getDataset, getDatasetValidation, isUuid } from "@/lib/dal/datasets";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Validation report" };
export const dynamic = "force-dynamic";

const SEVERITY_TONE = {
  error: "critical",
  warning: "caution",
  info: "neutral",
} as const;

const SEVERITY_LABEL = {
  error: "Blocking",
  warning: "Warning",
  info: "Note",
} as const;

/**
 * The validation report.
 *
 * Findings are grouped by severity with the blocking ones first, because a
 * blocking finding is the only thing that stops the next stage. Each finding
 * states what was found and what to do about it.
 */
export default async function ValidationPage({
  params,
}: PageProps<"/datasets/[id]/validation">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const dataset = await getDataset(id);
  if (!dataset) notFound();
  const validation = await getDatasetValidation(id);

  if (!validation) {
    return (
      <>
        <PageHeader title="Validation report" />
        <Card>
          <EmptyState
            title="This dataset has not been validated yet"
            description="Validation measures the file itself: row and column counts, missing values, duplicate rows, and whether the churn target is usable. Run it before doing anything else."
            action={<RevalidateDatasetButton datasetId={id} label="Run validation" />}
          />
        </Card>
      </>
    );
  }

  const issues = validation.issues ?? [];
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const notes = issues.filter((issue) => issue.severity === "info");
  const canContinue = errors.length === 0;

  return (
    <>
      <PageHeader
        title="Validation report"
        description={`${dataset.name} — measured from the uploaded file on ${formatDate(
          validation.created_at,
          "full",
        )}.`}
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
            <RevalidateDatasetButton datasetId={id} />
            {canContinue ? (
              <ButtonLink
                href={`/datasets/${id}/preprocessing`}
                size="sm"
                variant="primary"
              >
                Continue to preprocessing
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <Section title="Result">
        <Card>
          <StatGrid>
            <Stat
              label="Verdict"
              value={canContinue ? "Passed" : "Failed"}
              tone={canContinue ? "positive" : "critical"}
              hint={
                canContinue
                  ? "This dataset can be preprocessed."
                  : "Fix the blocking findings first."
              }
            />
            <Stat
              label="Blocking"
              value={errors.length}
              tone={errors.length > 0 ? "critical" : "neutral"}
            />
            <Stat
              label="Warnings"
              value={warnings.length}
              tone={warnings.length > 0 ? "caution" : "neutral"}
            />
            <Stat label="Notes" value={notes.length} />
          </StatGrid>
        </Card>
      </Section>

      {errors.length > 0 ? (
        <Section title="Blocking findings">
          <div className="space-y-3">
            {errors.map((issue, index) => (
              <ErrorState
                key={`${issue.code}-${index}`}
                title={issue.message}
                message={
                  <>
                    {issue.detail ?? "This must be corrected before the dataset can be used."}
                    {issue.column ? (
                      <>
                        {" "}
                        <span className="text-ink-muted">
                          Column: <code className="font-mono">{issue.column}</code>
                        </span>
                      </>
                    ) : null}
                    {issue.affected_count ? (
                      <>
                        {" "}
                        <span className="text-ink-muted">
                          {formatNumber(issue.affected_count)} row(s) affected.
                        </span>
                      </>
                    ) : null}
                  </>
                }
                nextAction="Correct the source file and upload it again. The stored copy cannot be edited in place, so a corrected upload creates a new dataset and leaves this one intact for reference."
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="All findings"
        description="Grouped by severity. Blocking findings stop the workflow; the rest are recorded so the decision to proceed is deliberate."
      >
        <Card>
          {issues.length === 0 ? (
            <EmptyState
              title="No findings"
              description="Nothing about this file raised a question. That is a good sign, not a guarantee: it means the structure matched what the pipeline expects."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Severity</Th>
                  <Th>Finding</Th>
                  <Th>Column</Th>
                  <Th align="right">Affected</Th>
                  <Th>Code</Th>
                </tr>
              </thead>
              <tbody>
                {[...errors, ...warnings, ...notes].map((issue, index) => (
                  <Tr key={`${issue.code}-${index}`}>
                    <Td>
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset ${
                          SEVERITY_TONE[issue.severity] === "critical"
                            ? "bg-critical-soft text-critical ring-critical-line"
                            : SEVERITY_TONE[issue.severity] === "caution"
                              ? "bg-caution-soft text-caution ring-caution-line"
                              : "bg-surface-sunken text-ink-muted ring-line"
                        }`}
                      >
                        {SEVERITY_LABEL[issue.severity]}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-ink">{issue.message}</span>
                      {issue.detail ? (
                        <p className="mt-0.5 text-2xs text-ink-muted">{issue.detail}</p>
                      ) : null}
                    </Td>
                    <Td className="font-mono text-2xs text-ink-muted">
                      {issue.column ?? "—"}
                    </Td>
                    <Td align="right" className="text-ink-muted">
                      {issue.affected_count
                        ? formatNumber(issue.affected_count)
                        : "—"}
                    </Td>
                    <Td className="font-mono text-2xs text-ink-faint">
                      {issue.code}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Section>

      <Section title="What was measured">
        <Card>
          <CardHeader
            title="File summary"
            description="Every figure below is calculated from the uploaded file."
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              {(
                [
                  ["Rows", formatNumber(validation.row_count)],
                  ["Columns", formatNumber(validation.column_count)],
                  [
                    "Churn rate",
                    dataset.targetPositiveRate !== null
                      ? formatPercent(dataset.targetPositiveRate, 2)
                      : "—",
                  ],
                  ["Duplicate rows", formatNumber(dataset.duplicateRowCount)],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-2xs tracking-wide text-ink-subtle uppercase">
                    {label}
                  </dt>
                  <dd className="text-lg font-semibold tabular text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 border-t border-line pt-3 text-xs text-ink-subtle">
              Status of the stored dataset:{" "}
              <span className="inline-flex align-middle">
                <StatusBadge status={dataset.status} />
              </span>
            </p>
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
