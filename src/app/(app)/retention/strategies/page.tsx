import type { Metadata } from "next";
import { StrategyForm, StrategyStatusControl } from "@/components/retention/strategy-panels";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
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
import { listStrategies } from "@/lib/dal/retention";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Retention strategies" };
export const dynamic = "force-dynamic";

/**
 * The retention strategy library.
 *
 * A strategy is a model-informed suggestion. Only approved strategies are
 * offered on a customer page, so approval is a real gate rather than a label.
 */
export default async function StrategiesPage() {
  const [strategies, actor] = await Promise.all([
    listStrategies(),
    currentActor(),
  ]);
  const canManage = actor?.role === "admin" || actor?.role === "analyst";

  const byStatus = (status: string) => strategies.filter((s) => s.status === status);
  const approved = byStatus("approved");
  const inReview = [...byStatus("proposed"), ...byStatus("draft")];
  const closed = [...byStatus("rejected"), ...byStatus("retired")];

  return (
    <>
      <PageHeader
        title="Retention strategies"
        description="Reusable, model-informed ideas about what might help. Each is matched to a customer by the features that pushed that customer's risk up."
        actions={
          <ButtonLink href="/retention" size="sm">
            ← Retention actions
          </ButtonLink>
        }
      />

      <div className="mb-6">
        <Notice tone="info" title="Suggestions, not promises">
          A strategy here says what the model suggests might be worth trying. It
          is not a prediction that the intervention will work. Approval means a
          person has reviewed it and considers it reasonable to offer, not that
          its effect has been demonstrated.
        </Notice>
      </div>

      {strategies.length === 0 ? (
        <Card>
          <EmptyState
            title="No strategies yet"
            description="A strategy captures one model driver and what a telecom team could do about it. Create them from the global feature importance on a model page, so each is tied to a feature the model actually relies on."
            action={
              canManage ? (
                <ButtonLink href="/models" variant="primary" size="sm">
                  Review feature importance
                </ButtonLink>
              ) : undefined
            }
          />
        </Card>
      ) : null}

      {approved.length > 0 ? (
        <Section
          title="Approved"
          description="Offered automatically on customer pages where the matching driver pushed risk up."
        >
          <StrategyTable strategies={approved} canManage={canManage} />
        </Section>
      ) : null}

      {inReview.length > 0 ? (
        <Section
          title="In review"
          description="Not yet offered to anyone. Approve a strategy when it looks reasonable."
        >
          <StrategyTable strategies={inReview} canManage={canManage} />
        </Section>
      ) : null}

      {closed.length > 0 ? (
        <Section title="Rejected or retired">
          <StrategyTable strategies={closed} canManage={canManage} />
        </Section>
      ) : null}

      {canManage ? (
        <Section title="Create a strategy">
          <Card>
            <CardHeader
              title="New strategy"
              description="Tie it to a source column so it can be matched against a customer's SHAP contributions."
            />
            <CardBody>
              <StrategyForm />
            </CardBody>
          </Card>
        </Section>
      ) : null}
    </>
  );
}

function StrategyTable({
  strategies,
  canManage,
}: {
  strategies: Awaited<ReturnType<typeof listStrategies>>;
  canManage: boolean;
}) {
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Strategy</Th>
            <Th>Risk driver</Th>
            <Th>When it applies</Th>
            <Th>Priority</Th>
            <Th>Status</Th>
            <Th align="right">Actions</Th>
            {canManage ? <Th align="right">Review</Th> : null}
          </tr>
        </thead>
        <tbody>
          {strategies.map((strategy) => (
            <Tr key={strategy.id}>
              <Td>
                <span className="font-medium">{strategy.title}</span>
                <p className="mt-0.5 max-w-md text-2xs text-ink-subtle">
                  {strategy.description}
                </p>
                <p className="mt-1 max-w-md text-2xs text-ink-muted">
                  <span className="font-medium">Intervention: </span>
                  {strategy.suggestedIntervention}
                </p>
              </Td>
              <Td className="text-xs">
                <span className="text-ink">{strategy.riskDriver}</span>
                {strategy.sourceColumn ? (
                  <span className="block font-mono text-2xs text-ink-subtle">
                    {strategy.sourceColumn}
                  </span>
                ) : (
                  <span className="block text-2xs text-caution">
                    no source column, cannot be matched
                  </span>
                )}
              </Td>
              <Td className="max-w-xs text-2xs text-ink-muted">
                {strategy.triggeringCondition}
              </Td>
              <Td>
                <Badge
                  tone={
                    strategy.priority === "critical" || strategy.priority === "high"
                      ? "critical"
                      : strategy.priority === "medium"
                        ? "caution"
                        : "neutral"
                  }
                >
                  {strategy.priority}
                </Badge>
              </Td>
              <Td>
                <StatusBadge status={strategy.status} />
                {strategy.approvedAt ? (
                  <span className="block text-2xs text-ink-subtle">
                    {formatDate(strategy.approvedAt, "short")}
                    {strategy.approvedByName
                      ? ` by ${strategy.approvedByName}`
                      : ""}
                  </span>
                ) : null}
              </Td>
              <Td align="right" className="text-xs">
                {strategy.totalActionCount > 0 ? (
                  <>
                    <span className="tabular">{strategy.openActionCount}</span> open
                    <span className="block text-2xs text-ink-subtle">
                      {strategy.totalActionCount} total
                    </span>
                  </>
                ) : (
                  <span className="text-ink-faint">none yet</span>
                )}
              </Td>
              {canManage ? (
                <Td align="right">
                  <StrategyStatusControl
                    strategyId={strategy.id}
                    currentStatus={strategy.status}
                  />
                </Td>
              ) : null}
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
