import type { Metadata } from "next";
import Link from "next/link";
import { RetentionFilters } from "@/components/retention/filters";
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
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
import { getRetentionSummary, listActions } from "@/lib/dal/retention";
import { currentActor } from "@/lib/dal/access";
import { isUuid } from "@/lib/dal/datasets";
import { formatDate, formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "Retention" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Retention work.
 *
 * Actions, not outcomes. The page says so explicitly, because a completed
 * action records that someone did the work, not that the customer was saved.
 */
export default async function RetentionPage({
  searchParams,
}: PageProps<"/retention">) {
  const params = await searchParams;
  const status = typeof params.status === "string" ? params.status : "all";
  const priority = typeof params.priority === "string" ? params.priority : "all";
  const customerId =
    typeof params.customerId === "string" && isUuid(params.customerId)
      ? params.customerId
      : "";
  const page =
    typeof params.page === "string"
      ? Math.max(1, Number.parseInt(params.page, 10) || 1)
      : 1;

  const [result, summary, actor] = await Promise.all([
    listActions({
      status,
      priority,
      customerId: customerId || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    getRetentionSummary(),
    currentActor(),
  ]);

  const canCreate = actor?.role === "admin" || actor?.role === "analyst";

  const link = (changes: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      status,
      priority,
      customerId: customerId || undefined,
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
    return `/retention?${next.toString()}`;
  };

  const today = new Date();

  return (
    <>
      <PageHeader
        title="Retention"
        description="Actions taken in response to model findings, and where they stand. An action records work committed, not a customer saved."
        actions={
          <ButtonLink href="/retention/strategies" size="sm">
            Strategy library
          </ButtonLink>
        }
      />

      <Section title="Overview">
        <Card>
          <StatGrid>
            <Stat
              label="Open actions"
              value={summary.open}
              tone={summary.open > 0 ? "info" : "neutral"}
            />
            <Stat
              label="Past the follow-up date"
              value={summary.overdue}
              tone={summary.overdue > 0 ? "critical" : "neutral"}
            />
            <Stat
              label="Due within 7 days"
              value={summary.dueSoon}
              tone={summary.dueSoon > 0 ? "caution" : "neutral"}
            />
            <Stat
              label="Unassigned"
              value={summary.unassigned}
              tone={summary.unassigned > 0 ? "caution" : "neutral"}
            />
          </StatGrid>
        </Card>
      </Section>

      {customerId ? (
        <div className="mb-4">
          <p className="text-sm text-ink-muted">
            Showing actions for one customer.{" "}
            <Link href="/retention" className="text-action underline underline-offset-2">
              Show all
            </Link>
            .
          </p>
        </div>
      ) : null}

      <RetentionFilters status={status} priority={priority} />

      <Section>
        <Card>
          {result.items.length === 0 ? (
            <EmptyState
              title={
                status !== "all" || priority !== "all" || customerId
                  ? "No actions match those filters"
                  : "No retention actions yet"
              }
              description={
                status !== "all" || priority !== "all" || customerId
                  ? "Try a different status or priority, or clear the filters."
                  : canCreate
                    ? "Actions are created from a customer page, where the model's findings for that customer are shown. Open a high-risk customer and turn the findings into something you can act on."
                    : "No retention actions have been recorded yet. Ask an analyst to create one from a customer page."
              }
              action={
                status !== "all" || priority !== "all" || customerId ? (
                  <ButtonLink href="/retention" variant="primary" size="sm">
                    Clear filters
                  </ButtonLink>
                ) : canCreate ? (
                  <ButtonLink href="/customers" variant="primary" size="sm">
                    Open a customer
                  </ButtonLink>
                ) : undefined
              }
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Action</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                    <Th>Priority</Th>
                    <Th>Assigned</Th>
                    <Th align="right">Follow-up</Th>
                    <Th align="right">Detail</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((action) => {
                    const overdue =
                      action.dueDate !== null &&
                      new Date(action.dueDate) < today &&
                      action.status !== "completed" &&
                      action.status !== "cancelled";
                    return (
                      <Tr key={action.id}>
                        <Td>
                          <Link
                            href={`/retention/${action.id}`}
                            className="font-medium text-action underline-offset-2 hover:underline"
                          >
                            {action.title}
                          </Link>
                          {action.strategyTitle ? (
                            <p className="text-2xs text-ink-subtle">
                              from: {action.strategyTitle}
                            </p>
                          ) : null}
                        </Td>
                        <Td>
                          <Link
                            href={`/customers/${action.customerId}`}
                            className="text-xs text-action underline-offset-2 hover:underline"
                          >
                            {action.customerExternalId}
                          </Link>
                        </Td>
                        <Td>
                          <StatusBadge status={action.status} />
                        </Td>
                        <Td>
                          <Badge
                            tone={
                              action.priority === "critical" || action.priority === "high"
                                ? "critical"
                                : action.priority === "medium"
                                  ? "caution"
                                  : "neutral"
                            }
                          >
                            {action.priority}
                          </Badge>
                        </Td>
                        <Td className="text-xs text-ink-muted">
                          {action.assignedToName ?? (
                            <span className="text-caution">Unassigned</span>
                          )}
                        </Td>
                        <Td
                          align="right"
                          className={`text-xs ${overdue ? "font-medium text-critical" : "text-ink-muted"}`}
                        >
                          {action.dueDate ? (
                            <>
                              {formatDate(action.dueDate, "short")}
                              {overdue ? (
                                <span className="block text-2xs">overdue</span>
                              ) : null}
                            </>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td align="right">
                          <Link
                            href={`/retention/${action.id}`}
                            className="text-xs text-action underline underline-offset-2"
                          >
                            Open
                          </Link>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>

              <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
                <p className="text-ink-subtle">
                  Showing {(page - 1) * PAGE_SIZE + 1} to{" "}
                  {Math.min(page * PAGE_SIZE, result.total)} of{" "}
                  {formatNumber(result.total)}
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
            </>
          )}
        </Card>
      </Section>

      <Section title="By status">
        <Card>
            {Object.keys(summary.byStatus).length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-muted">
                No actions have been created, so there is nothing to break down.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Status</Th>
                    <Th align="right">Count</Th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.byStatus).map(([key, count]) => (
                    <Tr key={key}>
                      <Td>
                        <Link
                          href={link({ status: key })}
                          className="text-action underline-offset-2 hover:underline"
                        >
                          {key.replace(/_/g, " ")}
                        </Link>
                      </Td>
                      <Td align="right">{formatNumber(count)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
        </Card>
      </Section>
    </>
  );
}
