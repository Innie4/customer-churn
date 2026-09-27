import type { Metadata } from "next";
import Link from "next/link";
import { CustomerFilters } from "@/components/customers/customer-filters";
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
import { listCustomers } from "@/lib/dal/customers";
import { listDatasets } from "@/lib/dal/datasets";
import { formatPercent, formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * The customer list.
 *
 * Ranked by risk by default, because the operational question is who to contact
 * first. Search, filtering and sorting are all server-side, so a large customer
 * base does not have to be sent to the browser.
 */
export default async function CustomersPage({
  searchParams,
}: PageProps<"/customers">) {
  const params = await searchParams;
  const search = typeof params.search === "string" ? params.search : "";
  const risk =
    typeof params.risk === "string" &&
    ["all", "low", "medium", "high", "unscored"].includes(params.risk)
      ? params.risk
      : "all";
  const datasetId = typeof params.dataset === "string" ? params.dataset : "";
  const sort = typeof params.sort === "string" ? params.sort : "risk";
  const direction =
    typeof params.direction === "string" ? params.direction : "desc";
  const page =
    typeof params.page === "string"
      ? Math.max(1, Number.parseInt(params.page, 10) || 1)
      : 1;

  const [result, datasets] = await Promise.all([
    listCustomers({
      search: search || undefined,
      risk: risk as "all" | "low" | "medium" | "high" | "unscored",
      datasetId: datasetId || undefined,
      sort: sort as "risk",
      direction: direction as "asc" | "desc",
      page,
      pageSize: PAGE_SIZE,
    }),
    listDatasets(),
  ]);

  const { items, total, pageCount } = result;
  const scored = items.filter((item) => item.churnProbability !== null);
  const high = scored.filter((item) => item.riskCategory === "high").length;
  const awaitingExplanation = scored.filter(
    (item) => !item.hasExplanation,
  ).length;

  /** Build a link to the same page with one parameter changed. */
  const link = (changes: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      search: search || undefined,
      risk,
      dataset: datasetId || undefined,
      sort,
      direction,
      page: String(page),
      ...Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [
          key,
          value === undefined ? undefined : String(value),
        ]),
      ),
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value);
    }
    // Changing a filter always returns to the first page.
    if (!("page" in changes)) next.delete("page");
    return `/customers?${next.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Customers"
        description="Every customer the platform has loaded, with their current churn risk, the model that produced it, and whether an explanation exists."
      />

      <Section title="This page">
        <Card>
          <StatGrid>
            <Stat
              label="Matching customers"
              value={total.toLocaleString()}
              hint={search || risk !== "all" || datasetId ? "after filtering" : "total loaded"}
            />
            <Stat
              label="High risk on this page"
              value={high}
              tone={high > 0 ? "critical" : "neutral"}
            />
            <Stat
              label="Awaiting explanation"
              value={awaitingExplanation}
              tone={awaitingExplanation > 0 ? "caution" : "neutral"}
              hint="Scored but not yet explained"
            />
            <Stat label="Page" value={`${page} of ${pageCount}`} />
          </StatGrid>
        </Card>
      </Section>

      <CustomerFilters
        search={search}
        risk={risk}
        datasetId={datasetId}
        sort={sort}
        datasets={datasets.map((dataset) => ({ id: dataset.id, name: dataset.name }))}
      />

      <Section>
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title={
                search || risk !== "all" || datasetId
                  ? "No customers match those filters"
                  : "No customers loaded yet"
              }
              description={
                search || risk !== "all" || datasetId
                  ? "Try a different search term, or clear the filters to see everyone."
                  : "Customers are loaded when a dataset is preprocessed. Upload a dataset and run preprocessing to populate this list."
              }
              action={
                search || risk !== "all" || datasetId ? (
                  <ButtonLink href="/customers" variant="primary" size="sm">
                    Clear filters
                  </ButtonLink>
                ) : (
                  <ButtonLink href="/datasets" variant="primary" size="sm">
                    Go to datasets
                  </ButtonLink>
                )
              }
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <Link href={link({ sort: "name" })} className="hover:underline">
                        Customer
                      </Link>
                    </Th>
                    <Th>
                      <Link href={link({ sort: "risk" })} className="hover:underline">
                        Risk
                      </Link>
                    </Th>
                    <Th align="right">
                      <Link
                        href={link({ sort: "probability" })}
                        className="hover:underline"
                      >
                        Probability
                      </Link>
                    </Th>
                    <Th>Model</Th>
                    <Th>Explanation</Th>
                    <Th align="right">
                      <Link href={link({ sort: "recent" })} className="hover:underline">
                        Scored
                      </Link>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((customer) => (
                    <Tr key={customer.id}>
                      <Td>
                        <Link
                          href={`/customers/${customer.id}`}
                          className="font-medium text-action underline-offset-2 hover:underline"
                        >
                          {customer.displayName ?? customer.externalId}
                        </Link>
                        <p className="text-2xs text-ink-subtle">
                          {customer.externalId}
                          {customer.observedChurn !== null
                            ? ` · recorded outcome: ${
                                customer.observedChurn === 1 ? "churned" : "stayed"
                              }`
                            : ""}
                        </p>
                      </Td>
                      <Td>
                        {customer.riskCategory ? (
                          <RiskBadge risk={customer.riskCategory} />
                        ) : (
                          <span className="text-2xs text-ink-faint">not scored</span>
                        )}
                      </Td>
                      <Td align="right">
                        {customer.churnProbability !== null
                          ? formatPercent(customer.churnProbability, 1)
                          : "—"}
                      </Td>
                      <Td className="text-xs text-ink-muted">
                        {customer.modelName ?? "—"}
                        {customer.modelVersion ? (
                          <span className="block text-2xs text-ink-faint">
                            {customer.modelVersion}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {customer.churnProbability === null ? (
                          <span className="text-2xs text-ink-faint">—</span>
                        ) : customer.hasExplanation ? (
                          <Badge tone="positive">Ready</Badge>
                        ) : (
                          <Badge tone="caution">Not yet</Badge>
                        )}
                      </Td>
                      <Td align="right" className="text-xs text-ink-subtle">
                        {customer.predictedAt
                          ? formatRelative(customer.predictedAt)
                          : "—"}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>

              {pageCount > 1 ? (
                <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
                  <p className="text-ink-subtle">
                    Showing {(page - 1) * PAGE_SIZE + 1} to{" "}
                    {Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
                  </p>
                  <div className="flex gap-2">
                    {page > 1 ? (
                      <ButtonLink
                        href={link({ page: page - 1 })}
                        size="sm"
                        variant="secondary"
                      >
                        Previous
                      </ButtonLink>
                    ) : null}
                    {page < pageCount ? (
                      <ButtonLink
                        href={link({ page: page + 1 })}
                        size="sm"
                        variant="secondary"
                      >
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
