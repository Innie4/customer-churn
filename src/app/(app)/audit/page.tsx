import type { Metadata } from "next";
import Link from "next/link";
import { AuditFilters } from "@/components/audit/filters";
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  Section,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { listAuditActions, listAuditEntries } from "@/lib/dal/reports";
import { formatDate, formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "Audit trail" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const OUTCOME_TONE: Record<string, "positive" | "caution" | "critical"> = {
  success: "positive",
  failure: "caution",
  denied: "critical",
};

/**
 * The audit trail.
 *
 * Who did what, when, and with what outcome. The table is append-only at the
 * database level, so entries cannot be edited or removed even by direct SQL.
 */
export default async function AuditPage({
  searchParams,
}: PageProps<"/audit">) {
  const params = await searchParams;
  const action = typeof params.action === "string" ? params.action : "all";
  const outcome = typeof params.outcome === "string" ? params.outcome : "all";
  const search = typeof params.search === "string" ? params.search : "";
  const page =
    typeof params.page === "string"
      ? Math.max(1, Number.parseInt(params.page, 10) || 1)
      : 1;

  const [result, actions] = await Promise.all([
    listAuditEntries({
      action,
      outcome,
      search: search || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    listAuditActions(),
  ]);

  const denied = result.items.filter((entry) => entry.outcome === "denied").length;

  const link = (changes: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      action,
      outcome,
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
    return `/audit?${next.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Consequential activity across the platform, most recent first. Entries cannot be edited or deleted, by the application or directly in the database."
        actions={
          <ButtonLink href="/reports" size="sm">
            Export as a report
          </ButtonLink>
        }
      />

      <div className="mb-6">
        <Notice tone="info" title="What is recorded, and what is not">
          Sign-ins, uploads, validation, preprocessing, training, activation,
          predictions, explanations, retention changes, report generation and
          settings changes — with who, when and the outcome. Secrets, tokens and
          credentials are never written here; the audit writer redacts them
          before they reach the table.
        </Notice>
      </div>

      <AuditFilters
        action={action}
        outcome={outcome}
        search={search}
        actions={actions}
      />

      <Section>
        <Card>
          {result.items.length === 0 ? (
            <EmptyState
              title={
                action !== "all" || outcome !== "all" || search
                  ? "No entries match those filters"
                  : "No activity recorded yet"
              }
              description={
                action !== "all" || outcome !== "all" || search
                  ? "Try a different filter or clear the search."
                  : "Activity appears here as soon as someone signs in or changes something."
              }
              action={
                action !== "all" || outcome !== "all" || search ? (
                  <ButtonLink href="/audit" variant="primary" size="sm">
                    Clear filters
                  </ButtonLink>
                ) : undefined
              }
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th align="right">When</Th>
                    <Th>Actor</Th>
                    <Th>Action</Th>
                    <Th>Resource</Th>
                    <Th>Outcome</Th>
                    <Th>Context</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((entry) => (
                    <Tr key={entry.id}>
                      <Td align="right" className="text-xs whitespace-nowrap text-ink-muted">
                        {formatDate(entry.createdAt, "full")}
                      </Td>
                      <Td className="text-xs">
                        {entry.actorEmail ?? (
                          <span className="text-ink-faint">system</span>
                        )}
                      </Td>
                      <Td>
                        <code className="font-mono text-2xs">
                          {entry.action}
                        </code>
                      </Td>
                      <Td className="text-2xs text-ink-muted">
                        {entry.resourceType
                          ? `${entry.resourceType}${
                              entry.resourceId
                                ? ` ${entry.resourceId.slice(0, 8)}`
                                : ""
                            }`
                          : "—"}
                      </Td>
                      <Td>
                        <Badge tone={OUTCOME_TONE[entry.outcome] ?? "neutral"}>
                          {entry.outcome}
                        </Badge>
                      </Td>
                      <Td className="max-w-56">
                        {Object.keys(entry.metadata).length > 0 ? (
                          <details>
                            <summary className="cursor-pointer text-2xs text-ink-muted">
                              {Object.keys(entry.metadata).length} field(s)
                            </summary>
                            <dl className="mt-1 space-y-0.5">
                              {Object.entries(entry.metadata).map(
                                ([key, value]) => (
                                  <div key={key} className="flex gap-1.5 text-2xs">
                                    <dt className="text-ink-subtle">{key}:</dt>
                                    <dd className="min-w-0 break-all font-mono text-ink-muted">
                                      {typeof value === "object"
                                        ? JSON.stringify(value)
                                        : String(value)}
                                    </dd>
                                  </div>
                                ),
                              )}
                            </dl>
                          </details>
                        ) : (
                          <span className="text-2xs text-ink-faint">—</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>

              <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
                <p className="text-ink-subtle">
                  Showing {(page - 1) * PAGE_SIZE + 1} to{" "}
                  {Math.min(page * PAGE_SIZE, result.total)} of{" "}
                  {formatNumber(result.total)} entries
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

      {denied > 0 ? (
        <Notice tone="caution" title={`${denied} denied attempt(s) on this page`}>
          A denied attempt is recorded rather than hidden, because a pattern of
          them is worth investigating.{" "}
          <Link href={link({ outcome: "denied" })} className="underline underline-offset-2">
            Show only denied attempts
          </Link>
          .
        </Notice>
      ) : null}

      <p className="mt-3 text-xs text-ink-subtle">
        {formatNumber(actions.length)} distinct action type(s) recorded
        historically. A failed sign-in is recorded by the address attempted, so a
        brute-force attempt is attributable even though no account matched.
      </p>
    </>
  );
}
