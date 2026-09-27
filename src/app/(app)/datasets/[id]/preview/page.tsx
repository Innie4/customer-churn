import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ButtonLink,
  Card,
  CardBody,
  Detail,
  DetailList,
  EmptyState,
  PageHeader,
  Section,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import {
  getDataset,
  getDatasetPreview,
  getDatasetValidation,
  isUuid,
} from "@/lib/dal/datasets";
import { formatBytes, formatDate, formatNumber, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Dataset preview" };
export const dynamic = "force-dynamic";

const PREVIEW_ROWS = 25;

/**
 * A look at the actual rows.
 *
 * Reads the stored file directly, so what is shown is what was uploaded rather
 * than a summary of it. An operator checking a dataset needs to see real values
 * before committing to a training run.
 */
export default async function DatasetPreviewPage({
  params,
}: PageProps<"/datasets/[id]/preview">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const [dataset, validation, preview] = await Promise.all([
    getDataset(id),
    getDatasetValidation(id),
    getDatasetPreview(id, PREVIEW_ROWS),
  ]);
  if (!dataset) notFound();

  const errors = validation?.error_count ?? 0;
  const targetColumn = dataset.targetColumn;

  return (
    <>
      <PageHeader
        title="Data preview"
        description={`${dataset.name} — the first ${PREVIEW_ROWS} rows of the uploaded file, exactly as parsed.`}
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
            <ButtonLink href={`/datasets/${id}/validation`} size="sm">
              Validation report
            </ButtonLink>
            <ButtonLink
              href={`/datasets/${id}/preprocessing`}
              size="sm"
              variant="primary"
            >
              Continue to preprocessing
            </ButtonLink>
          </>
        }
      />

      <Section
        title="Row sample"
        description={
          preview.total > preview.rows.length
            ? `Showing ${preview.rows.length} of ${formatNumber(preview.total)} rows.`
            : `All ${formatNumber(preview.total)} rows.`
        }
      >
        <Card>
          {preview.rows.length === 0 ? (
            <EmptyState
              title="This file has no rows to show"
              description="An empty dataset cannot be validated or trained on. Check the source file and upload it again."
            />
          ) : (
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <Th align="right">#</Th>
                    {preview.columns.map((column) => (
                      <Th key={column}>
                        {column}
                        {column === targetColumn ? (
                          <span className="ml-1 text-2xs font-normal text-info">
                            target
                          </span>
                        ) : null}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <Tr key={index}>
                      <Td align="right" className="text-ink-faint">
                        {index + 1}
                      </Td>
                      {preview.columns.map((column) => {
                        const value = row[column];
                        const isTarget = column === targetColumn;
                        return (
                          <Td
                            key={column}
                            className={`font-mono text-2xs whitespace-nowrap ${
                              isTarget
                                ? value === "Yes"
                                  ? "text-critical"
                                  : "text-positive"
                                : ""
                            }`}
                          >
                            {value === null || value === undefined || value === ""
                              ? <span className="text-caution">blank</span>
                              : String(value)}
                          </Td>
                        );
                      })}
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Section>

      <Section
        title="Column structure"
        description="Each column as observed, with the values that were found in it."
      >
        <Card>
          {dataset.columns.length === 0 ? (
            <EmptyState
              title="No column information yet"
              description="Re-run validation on the dataset page to measure its structure."
              action={
                <ButtonLink
                  href={`/datasets/${id}/validation`}
                  variant="primary"
                  size="sm"
                >
                  Go to validation
                </ButtonLink>
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th align="right">#</Th>
                  <Th>Column</Th>
                  <Th>Type</Th>
                  <Th>Sample values</Th>
                  <Th align="right">Nulls</Th>
                  <Th align="right">Range</Th>
                </tr>
              </thead>
              <tbody>
                {dataset.columns.map((column) => (
                  <Tr key={column.id}>
                    <Td align="right" className="text-ink-faint">
                      {column.position}
                    </Td>
                    <Td>
                      <span className="font-medium">{column.name}</span>
                      {column.isTarget ? (
                        <span className="ml-1.5 rounded-full bg-info-soft px-1.5 py-0.5 text-2xs text-info">
                          target
                        </span>
                      ) : null}
                      <p className="text-2xs text-ink-subtle">{column.pandasDtype}</p>
                    </Td>
                    <Td className="text-ink-muted">{column.inferredType}</Td>
                    <Td>
                      <span className="font-mono text-2xs text-ink-muted">
                        {column.sampleValues.length > 0
                          ? column.sampleValues
                              .map((value) =>
                                value === null || value === undefined
                                  ? "∅"
                                  : String(value),
                              )
                              .join(", ")
                          : "—"}
                      </span>
                    </Td>
                    <Td align="right">
                      {column.nullCount > 0 ? (
                        <span className="text-caution">
                          {formatNumber(column.nullCount)}
                          <span className="text-2xs text-ink-subtle">
                            {" "}
                            ({formatPercent(column.nullFraction, 1)})
                          </span>
                        </span>
                      ) : (
                        <span className="text-ink-faint">0</span>
                      )}
                    </Td>
                    <Td align="right" className="text-xs text-ink-muted">
                      {column.minValue !== null && column.maxValue !== null
                        ? `${column.minValue} – ${column.maxValue}`
                        : "—"}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Section>

      <Section title="File">
        <Card>
          <CardBody>
            <DetailList>
              <Detail label="Original file">{dataset.originalFilename}</Detail>
              <Detail label="Size">{formatBytes(dataset.sizeBytes)}</Detail>
              <Detail label="Rows">{formatNumber(dataset.rowCount)}</Detail>
              <Detail label="Uploaded">{formatDate(dataset.createdAt, "full")}</Detail>
              <Detail label="Validation">
                {errors > 0
                  ? `${errors} error(s) found`
                  : "No blocking errors"}
              </Detail>
            </DetailList>
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
