import type { Metadata } from "next";
import Link from "next/link";
import { GeneratePredictionsPanel } from "@/components/models/generate-predictions";
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  PageHeader,
  RiskBadge,
  Section,
  Stat,
  StatGrid,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { listPredictions } from "@/lib/dal/customers";
import { listModels } from "@/lib/dal/models";
import { getRiskThresholds } from "@/lib/dal/settings";
import { currentActor } from "@/lib/dal/access";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Predictions" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Every prediction the platform has made.
 *
 * Each row traces to the model that produced it, so a number here is never
 * anonymous. Filters are server-side for the same reason the customer list is.
 */
export default async function PredictionsPage({
  searchParams,
}: PageProps<"/predictions">) {
  const params = await searchParams;
  const risk = typeof params.risk === "string" ? params.risk : "all";
  const search = typeof params.search === "string" ? params.search : "";
  const page =
    typeof params.page === "string"
      ? Math.max(1, Number.parseInt(params.page, 10) || 1)
      : 1;

  const [result, thresholds, actor, allModels] = await Promise.all([
    listPredictions({
      risk: ["all", "low", "medium", "high"].includes(risk)
        ? (risk as "all" | "low" | "medium" | "high")
        : "all",
      search: search || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    getRiskThresholds(),
    currentActor(),
    listModels(),
  ]);

  const canGenerate = actor?.role === "admin" || actor?.role === "analyst";
  const high = result.items.filter((p) => p.riskCategory === "high").length;
  const awaiting = result.items.filter((p) => !p.hasExplanation).length;

  const link = (changes: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      risk,
      search: search || undefined,
      page: String(page),
      ...Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [
          key,
          value === undefined ? undefined : String(value),
        ]),
      ),
    };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    if (!("page" in changes)) next.delete("page");
    return `/predictions?${next.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Predictions"
        description="Every churn prediction the platform has generated, with the model version that produced it and the risk thresholds that were in force."
        actions={
          canGenerate ? (
            <GeneratePredictionsPanel
              defaultThresholds={thresholds}
              models={allModels.map((model) => ({
                id: model.id,
                displayName: model.displayName,
                modelType: model.modelType,
                isActive: model.isActive,
                status: model.status,
              }))}
            />
          ) : null
        }
      />

      <Section title="This page">
        <Card>
          <StatGrid>
            <Stat label="Predictions" value={formatNumber(result.total)} />
            <Stat
              label="High risk on this page"
              value={high}
              tone={high > 0 ? "critical" : "neutral"}
            />
            <Stat
              label="Awaiting explanation"
              value={awaiting}
              tone={awaiting > 0 ? "caution" : "neutral"}
            />
            <Stat
              label="Current thresholds"
              value={`${formatPercent(thresholds.medium, 0)} / ${formatPercent(thresholds.high, 0)}`}
              hint="medium / high"
            />
          </StatGrid>
        </Card>
      </Section>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink">Risk:</span>
        {["all", "high", "medium", "low"].map((band) => (
          <Link
            key={band}
            href={link({ risk: band })}
            aria-current={risk === band ? "true" : undefined}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
              risk === band
                ? "bg-action-soft text-action ring-info-line"
                : "bg-surface text-ink-muted ring-line hover:bg-surface-sunken"
            }`}
          >
            {band === "all" ? "All" : band === "high" ? "High" : band === "medium" ? "Medium" : "Low"}
          </Link>
        ))}
        <form action={`/predictions`} className="ml-auto">
          <input type="hidden" name="risk" value={risk} />
          <input
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Customer identifier"
            aria-label="Search by customer identifier"
            className="rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint"
          />
          <button
            type="submit"
            className="ml-2 rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink hover:bg-surface-sunken"
          >
            Search
          </button>
        </form>
      </div>

      <Section>
        <Card>
          {result.items.length === 0 ? (
            <EmptyState
              title={
                search || risk !== "all"
                  ? "No predictions match those filters"
                  : "No predictions yet"
              }
              description={
                search || risk !== "all"
                  ? "Try a different search term, or clear the filter to see everything."
                  : "Predictions are produced by scoring customers with an activated model. Activate a model, then generate predictions."
              }
              action={
                search || risk !== "all" ? (
                  <ButtonLink href="/predictions" variant="primary" size="sm">
                    Clear filters
                  </ButtonLink>
                ) : (
                  <ButtonLink href="/models" variant="primary" size="sm">
                    Go to models
                  </ButtonLink>
                )
              }
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th align="right">Probability</Th>
                    <Th>Risk</Th>
                    <Th>Model</Th>
                    <Th>Explanation</Th>
                    <Th align="right">Scored</Th>
                    <Th align="right">Detail</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((prediction) => (
                    <Tr key={prediction.id}>
                      <Td>
                        <Link
                          href={`/predictions/${prediction.id}`}
                          className="font-medium text-action underline-offset-2 hover:underline"
                        >
                          {prediction.customerName ?? prediction.customerExternalId}
                        </Link>
                        <p className="text-2xs text-ink-subtle">
                          {prediction.customerExternalId}
                          {prediction.datasetName ? ` · ${prediction.datasetName}` : ""}
                        </p>
                      </Td>
                      <Td align="right">
                        {formatPercent(prediction.churnProbability, 2)}
                      </Td>
                      <Td>
                        <RiskBadge risk={prediction.riskCategory} />
                      </Td>
                      <Td className="text-xs text-ink-muted">
                        {prediction.modelName ?? "—"}
                        <span className="block text-2xs text-ink-faint">
                          {prediction.modelVersion}
                          {prediction.isActiveModel ? " · active" : ""}
                        </span>
                      </Td>
                      <Td>
                        {prediction.hasExplanation ? (
                          <Badge tone="positive">Ready</Badge>
                        ) : (
                          <Badge tone="caution">Not yet</Badge>
                        )}
                      </Td>
                      <Td align="right" className="text-xs text-ink-subtle">
                        {formatDate(prediction.predictedAt, "short")}
                      </Td>
                      <Td align="right">
                        <Link
                          href={`/customers/${prediction.customerId}`}
                          className="text-xs text-action underline underline-offset-2"
                        >
                          Open
                        </Link>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>

              {result.pageCount > 1 ? (
                <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
                  <p className="text-ink-subtle">
                    Showing {(page - 1) * PAGE_SIZE + 1} to{" "}
                    {Math.min(page * PAGE_SIZE, result.total)} of{" "}
                    {result.total.toLocaleString()}
                  </p>
                  <div className="flex gap-2">
                    {page > 1 ? (
                      <ButtonLink href={link({ page: page - 1 })} size="sm">
                        Previous
                      </ButtonLink>
                    ) : null}
                    {page < result.pageCount ? (
                      <ButtonLink href={link({ page: page + 1 })} size="sm">
                        Next
                      </ButtonLink>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </Section>
    </>
  );
}
