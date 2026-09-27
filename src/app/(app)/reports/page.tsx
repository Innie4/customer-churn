import type { Metadata } from "next";
import { GenerateReportPanel } from "@/components/reports/generate-report";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  Section,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { currentActor } from "@/lib/dal/access";
import { listDatasets } from "@/lib/dal/datasets";
import { listModels } from "@/lib/dal/models";
import { listReports } from "@/lib/dal/reports";
import { formatBytes, formatDate, formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * Reports.
 *
 * A completed report always has a stored file behind it, which the database
 * enforces. Downloads go through an authenticated route, never a public URL.
 */
export default async function ReportsPage() {
  const [reports, datasets, models, actor] = await Promise.all([
    listReports(50),
    listDatasets(),
    listModels(),
    currentActor(),
  ]);
  const canGenerate = actor?.role === "admin" || actor?.role === "analyst";

  const completed = reports.filter((report) => report.status === "completed");
  const failed = reports.filter((report) => report.status === "failed");

  return (
    <>
      <PageHeader
        title="Reports"
        description="Generated from stored data only. Every figure in a report was measured by the system, so a report can never contain a number the platform did not produce."
      />

      {canGenerate ? (
        <Section title="Generate a report">
          <GenerateReportPanel
            datasets={datasets.map((dataset) => ({
              id: dataset.id,
              name: dataset.name,
            }))}
            models={models
              .filter((model) => model.status === "completed")
              .map((model) => ({
                id: model.id,
                displayName: model.displayName,
              }))}
          />
        </Section>
      ) : null}

      {failed.length > 0 ? (
        <Section title="Failed attempts">
          <Notice tone="caution" title={`${failed.length} report(s) could not be generated`}>
            Failures are kept so the reason is visible rather than disappearing.
          </Notice>
          <div className="mt-3 space-y-3">
            {failed.map((report) => (
              <ErrorState
                key={report.id}
                title={report.title}
                message={report.error ?? "No reason was recorded."}
                nextAction="Adjust the report's scope and try again. If the data it needs does not exist yet, produce that first."
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Report history">
        <Card>
          {reports.length === 0 ? (
            <EmptyState
              title="No reports yet"
              description={
                canGenerate
                  ? "Generate a report above. Every report is built from stored data, so it reflects what the platform has actually measured."
                  : "No reports have been generated yet."
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Report</Th>
                  <Th>Type</Th>
                  <Th>Format</Th>
                  <Th>Status</Th>
                  <Th>Scope</Th>
                  <Th align="right">Size</Th>
                  <Th align="right">Generated</Th>
                  <Th align="right">Download</Th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <Tr key={report.id}>
                    <Td>
                      <span className="font-medium">{report.title}</span>
                      {report.generatedByName ? (
                        <p className="text-2xs text-ink-subtle">
                          by {report.generatedByName}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      {report.kind.replace(/_/g, " ")}
                    </Td>
                    <Td>
                      <Badge tone="neutral">
                        {report.format.toUpperCase()}
                      </Badge>
                    </Td>
                    <Td>
                      <StatusBadge status={report.status} />
                    </Td>
                    <Td className="max-w-48 text-2xs text-ink-muted">
                      {report.modelName ?? report.datasetName ?? "All data"}
                    </Td>
                    <Td align="right" className="text-xs text-ink-muted">
                      {report.sizeBytes ? formatBytes(report.sizeBytes) : "—"}
                    </Td>
                    <Td align="right" className="text-xs text-ink-subtle">
                      {report.completedAt
                        ? formatDate(report.completedAt, "short")
                        : formatDate(report.createdAt, "short")}
                    </Td>
                    <Td align="right">
                      {report.status === "completed" ? (
                        <a
                          href={`/api/reports/${report.id}/download`}
                          className="text-xs text-action underline underline-offset-2"
                          title="Downloads through an authenticated route"
                        >
                          Download
                        </a>
                      ) : (
                        <span className="text-2xs text-ink-faint">—</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Section>

      {completed.length > 0 ? (
        <p className="mt-3 text-xs text-ink-subtle">
          {formatNumber(completed.length)} report(s) available. Downloads are
          served through an authenticated route that checks the session, so a
          report is never reachable by an unauthenticated visitor.
        </p>
      ) : null}
    </>
  );
}
