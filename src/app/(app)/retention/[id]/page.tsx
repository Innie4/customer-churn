import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionStatusPanel, ActionEditForm } from "@/components/retention/action-panels";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Detail,
  DetailList,
  EmptyState,
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
import { isUuid } from "@/lib/dal/datasets";
import {
  ACTION_STATUS_LABELS,
  getAction,
  getActionHistory,
  type ActionStatus,
} from "@/lib/dal/retention";
import { listUsers } from "@/lib/dal/users";
import { formatDate, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Retention action" };
export const dynamic = "force-dynamic";

/**
 * One retention action.
 *
 * Shows the work, its history, and the model findings that justified it. The
 * history is append-only, so the record of what happened cannot be rewritten.
 */
export default async function RetentionActionPage({
  params,
}: PageProps<"/retention/[id]">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const action = await getAction(id);
  if (!action) notFound();

  const [history, actor, users] = await Promise.all([
    getActionHistory(id),
    currentActor(),
    listUsers().catch(() => []),
  ]);

  const canManage = actor?.role === "admin" || actor?.role === "analyst";
  const closed = action.status === "completed" || action.status === "cancelled";

  return (
    <>
      <PageHeader
        title={action.title}
        description={
          <>
            {action.customerExternalId}
            {action.customerName ? ` · ${action.customerName}` : ""}
            {action.strategyTitle ? ` · from strategy: ${action.strategyTitle}` : ""}
          </>
        }
        breadcrumb={
          <Link
            href="/retention"
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← Retention
          </Link>
        }
        actions={
          <>
            <StatusBadge status={action.status} />
            <Badge
              tone={
                action.priority === "critical" || action.priority === "high"
                  ? "critical"
                  : action.priority === "medium"
                    ? "caution"
                    : "neutral"
              }
            >
              {action.priority} priority
            </Badge>
            <ButtonLink
              href={`/customers/${action.customerId}`}
              size="sm"
              variant="primary"
            >
              Open the customer
            </ButtonLink>
          </>
        }
      />

      {closed ? (
        <div className="mb-6">
          <Notice
            tone={action.status === "completed" ? "positive" : "neutral"}
            title={`This action is ${action.status}`}
          >
            {action.completedAt
              ? `Completed on ${formatDate(action.completedAt, "full")}.`
              : action.cancelledAt
                ? `Cancelled on ${formatDate(action.cancelledAt, "full")}.`
                : ""}{" "}
            A closed action cannot be edited or reopened. If more work is needed,
            create a new one.
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="The action">
          <Card>
            <CardBody>
              {action.description ? (
                <p className="mb-4 text-sm text-ink">{action.description}</p>
              ) : null}
              <DetailList>
                <Detail label="Status">
                  {ACTION_STATUS_LABELS[action.status as ActionStatus] ??
                    action.status}
                </Detail>
                <Detail label="Customer">
                  <Link
                    href={`/customers/${action.customerId}`}
                    className="text-action underline underline-offset-2"
                  >
                    {action.customerExternalId}
                  </Link>
                </Detail>
                <Detail label="Assigned to">
                  {action.assignedToName ?? (
                    <span className="text-caution">Unassigned</span>
                  )}
                </Detail>
                <Detail label="Follow-up date">
                  {action.dueDate ? formatDate(action.dueDate, "long") : "—"}
                </Detail>
                <Detail label="Created">
                  {formatDate(action.createdAt, "full")}
                  {action.createdByName ? ` by ${action.createdByName}` : ""}
                </Detail>
                <Detail label="Risk when created">
                  {action.churnProbabilityAtCreation !== null
                    ? formatPercent(action.churnProbabilityAtCreation, 1)
                    : "—"}
                  {action.riskCategory ? ` (${action.riskCategory} risk)` : ""}
                </Detail>
              </DetailList>
              {action.notes ? (
                <div className="mt-4 border-t border-line pt-3">
                  <h3 className="text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
                    Notes
                  </h3>
                  <p className="mt-1 text-sm text-ink-muted">{action.notes}</p>
                </div>
              ) : null}
            </CardBody>
          </Card>
        </Section>

        <Section title="Progress">
          {canManage && !closed ? (
            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Move this action on"
                  description="Only transitions the workflow defines are allowed, and each one is recorded with who made it."
                />
                <CardBody>
                  <ActionStatusPanel
                    actionId={id}
                    currentStatus={action.status as ActionStatus}
                  />
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Edit the action" />
                <CardBody>
                  <ActionEditForm
                    actionId={id}
                    initialTitle={action.title}
                    initialDescription={action.description ?? ""}
                    initialPriority={action.priority}
                    initialDueDate={action.dueDate ?? ""}
                    initialNotes={action.notes ?? ""}
                    assignees={users.map((user) => ({
                      id: user.id,
                      fullName: user.fullName,
                    }))}
                  />
                </CardBody>
              </Card>
            </div>
          ) : closed ? (
            <Card>
              <CardBody>
                <p className="text-sm text-ink-muted">
                  This action is closed, so it cannot be changed. The history
                  below is the record of how it reached that point.
                </p>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody>
                <p className="text-sm text-ink-muted">
                  Your role does not allow changing retention actions. You can
                  read the full history below.
                </p>
              </CardBody>
            </Card>
          )}
        </Section>
      </div>

      <Section
        title="History"
        description="Every status change, with who made it. Entries cannot be edited or removed."
      >
        <Card>
          {history.length === 0 ? (
            <EmptyState
              title="No history recorded"
              description="This should not happen, because an action records its own creation. If you see this, the record is incomplete."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th align="right">When</Th>
                  <Th>Change</Th>
                  <Th>By</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((event) => (
                  <Tr key={event.id}>
                    <Td align="right" className="text-xs text-ink-muted">
                      {formatDate(event.changedAt, "full")}
                    </Td>
                    <Td className="text-sm">
                      {event.fromStatus ? (
                        <>
                          <span className="text-ink-subtle">
                            {event.fromStatus.replace(/_/g, " ")}
                          </span>
                          {" → "}
                        </>
                      ) : null}
                      <span className="font-medium">
                        {event.toStatus.replace(/_/g, " ")}
                      </span>
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      {event.changedByName ?? "System"}
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      {event.note ?? "—"}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Section>

      <Section title="What completion does and does not mean">
        <Card>
          <CardBody>
            <Notice tone="caution" title="An action records work, not an outcome">
              Marking this action complete records that the work was done. It does
              not establish that the customer was retained, and no measurement
              here should be read as evidence that the intervention worked.
              Whether an intervention succeeds depends on the customer and on
              what was actually offered.
            </Notice>
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
