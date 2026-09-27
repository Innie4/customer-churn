import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateActionForm, ExplainButton } from "@/components/customers/action-panels";
import {
  Badge,
  Bar,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Detail,
  DetailList,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  RiskBadge,
  Section,
  Stat,
  StatGrid,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { currentActor } from "@/lib/dal/access";
import { isUuid } from "@/lib/dal/datasets";
import {
  getCustomer,
  getExplanationForPrediction,
  suggestStrategiesForCustomer,
} from "@/lib/dal/customers";
import { formatDate, formatPercent, formatRelative, formatSigned, humanise } from "@/lib/format";

export const metadata: Metadata = { title: "Customer" };
export const dynamic = "force-dynamic";

/**
 * One customer.
 *
 * Structured around the four questions a retention manager actually has:
 * who is this, how much risk is there, why does the model think so, and what
 * should we consider doing. Each has its own section and each links to the next.
 */
export default async function CustomerPage({
  params,
}: PageProps<"/customers/[id]">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const actor = await currentActor();
  const customer = await getCustomer(id);
  if (!customer) notFound();

  const [explanation, strategies] = await Promise.all([
    customer.predictionId
      ? getExplanationForPrediction(customer.predictionId)
      : Promise.resolve(null),
    suggestStrategiesForCustomer(id),
  ]);

  const canAct = actor?.role === "admin" || actor?.role === "analyst";
  const attributes = Object.entries(customer.attributes).slice(0, 24);
  const maxContribution = explanation
    ? Math.max(
        ...explanation.contributions.map((item) => Math.abs(item.shap_value)),
        0.0001,
      )
    : 1;

  return (
    <>
      <PageHeader
        title={customer.displayName ?? customer.externalId}
        description={
          <>
            {customer.externalId} · {customer.datasetName}
            {customer.predictedAt
              ? ` · scored ${formatRelative(customer.predictedAt)}`
              : ""}
          </>
        }
        breadcrumb={
          <Link
            href="/customers"
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← All customers
          </Link>
        }
        actions={
          customer.riskCategory ? (
            <RiskBadge risk={customer.riskCategory} />
          ) : (
            <Badge tone="neutral">Not scored</Badge>
          )
        }
      />

      {/* 1. How much risk is there? ------------------------------------- */}
      <Section title="Risk">
        {customer.churnProbability === null ? (
          <Card>
            <EmptyState
              title="This customer has not been scored"
              description="A churn probability appears once an active model has been used to score them. Nothing is invented in the meantime."
              action={
                <ButtonLink href="/models" variant="primary" size="sm">
                  Go to models
                </ButtonLink>
              }
            />
          </Card>
        ) : (
          <Card>
            <StatGrid>
              <Stat
                label="Churn probability"
                value={formatPercent(customer.churnProbability, 2)}
                tone={
                  customer.riskCategory === "high"
                    ? "critical"
                    : customer.riskCategory === "medium"
                      ? "caution"
                      : "positive"
                }
                hint="The model's estimate, not a certainty"
              />
              <Stat label="Risk category" value={humanise(customer.riskCategory ?? "")} />
              <Stat
                label="Model"
                value={customer.modelName ?? "—"}
                hint={customer.modelVersion ? `Version ${customer.modelVersion}` : undefined}
              />
              <Stat
                label="Predicted"
                value={customer.predictedAt ? formatDate(customer.predictedAt, "short") : "—"}
              />
            </StatGrid>
            {customer.riskThresholds ? (
              <div className="border-t border-line px-4 py-3 text-xs text-ink-muted">
                Bands in force when this was scored: high at{" "}
                <span className="tabular">{formatPercent(customer.riskThresholds.high, 0)}</span>,
                medium at{" "}
                <span className="tabular">
                  {formatPercent(customer.riskThresholds.medium, 0)}
                </span>
                . The thresholds travel with the prediction, so this band can
                always be re-derived from the probability.
              </div>
            ) : null}
          </Card>
        )}
      </Section>

      {/* 2. Why does the model think so? --------------------------------- */}
      <Section
        title="Why the model says this"
        description="SHAP values split the prediction into the factors that pushed it up and the factors that pushed it down."
        actions={
          canAct && customer.churnProbability !== null && !explanation ? (
            <ExplainButton customerId={id} />
          ) : null
        }
      >
        {!customer.churnProbability ? (
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted">
                There is no prediction to explain yet. Score this customer first,
                then the explanation becomes available.
              </p>
            </CardBody>
          </Card>
        ) : !explanation ? (
          <Card>
            <EmptyState
              title="No explanation generated yet"
              description="The prediction stands on its own, but an explanation is what turns a probability into something a retention manager can act on. Generate one to see which factors this customer's score depends on."
              action={
                canAct ? <ExplainButton customerId={id} label="Generate explanation" /> : undefined
              }
            />
          </Card>
        ) : explanation.status === "failed" ? (
          <ErrorState
            title="The explanation could not be generated"
            message={explanation.error ?? "No reason was recorded."}
            nextAction="The prediction above is unaffected and remains valid. Try generating the explanation again, and check the machine learning service if it keeps failing."
          />
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="In plain language"
                description="Written for someone who does not work with SHAP values."
              />
              <CardBody>
                <p className="text-sm text-ink">{explanation.summary}</p>
                {explanation.additivityWarning ? (
                  <div className="mt-3">
                    <Notice tone="caution" title="Read direction, not amount">
                      The contributions do not fully reconstruct this
                      prediction, so the absolute figures are approximate. The
                      direction and the relative order are still meaningful.
                    </Notice>
                  </div>
                ) : null}
              </CardBody>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title="Pushed risk up"
                  description="This factor increased the model&rsquo;s estimated churn risk."
                />
                <CardBody>
                  {explanation.topIncreasing.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      No factor pushed this customer&rsquo;s risk up. Their score
                      comes entirely from factors pulling it down.
                    </p>
                  ) : (
                    explanation.topIncreasing.map((item) => (
                      <Bar
                        key={item.feature}
                        label={item.label}
                        value={item.shap_value}
                        max={maxContribution}
                        display={formatSigned(item.shap_value)}
                        tone="critical"
                        hint={item.value}
                      />
                    ))
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Pushed risk down"
                  description="This factor reduced the model&rsquo;s estimated churn risk."
                />
                <CardBody>
                  {explanation.topReducing.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      No factor pulled this customer&rsquo;s risk down.
                    </p>
                  ) : (
                    explanation.topReducing.map((item) => (
                      <Bar
                        key={item.feature}
                        label={item.label}
                        value={item.shap_value}
                        max={maxContribution}
                        display={formatSigned(item.shap_value)}
                        tone="positive"
                        hint={item.value}
                      />
                    ))
                  )}
                </CardBody>
              </Card>
            </div>

            <Card>
              <CardHeader
                title="Every factor"
                description="All contributions, ranked by size. Association and contribution, not causation."
              />
              <Table>
                <thead>
                  <tr>
                    <Th align="right">#</Th>
                    <Th>Factor</Th>
                    <Th>Value</Th>
                    <Th align="right">Contribution</Th>
                    <Th>Effect</Th>
                  </tr>
                </thead>
                <tbody>
                  {explanation.contributions.slice(0, 20).map((item, index) => (
                    <Tr key={item.feature}>
                      <Td align="right" className="text-ink-faint">
                        {index + 1}
                      </Td>
                      <Td>
                        <span className="font-medium">{item.label}</span>
                        <p className="text-2xs text-ink-subtle">{item.source_column}</p>
                      </Td>
                      <Td className="font-mono text-2xs text-ink-muted">
                        {item.value}
                      </Td>
                      <Td
                        align="right"
                        className={
                          item.shap_value > 0 ? "text-critical" : "text-positive"
                        }
                      >
                        {formatSigned(item.shap_value)}
                      </Td>
                      <Td className="text-2xs text-ink-muted">
                        {item.shap_value > 0
                          ? "increased risk"
                          : "reduced risk"}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="border-t border-line px-4 py-3">
                <p className="text-xs text-ink-subtle">
                  {explanation.disclaimer}
                </p>
              </div>
            </Card>
          </div>
        )}
      </Section>

      {/* 3. What should we consider doing? ------------------------------ */}
      <Section
        title="What to consider doing"
        description="Strategies matched to this customer's own risk drivers. Suggestions for human review, not guaranteed outcomes."
      >
        <div className="space-y-4">
          <Notice tone="info" title="These are suggestions, not prescriptions">
            A strategy here is a model-informed idea about what might help. It is
            not a prediction that the intervention will work, and the decision to
            act is yours.
          </Notice>

          {strategies.length === 0 ? (
            <Card>
              <EmptyState
                title={
                  explanation
                    ? "No approved strategy matches this customer's drivers"
                    : "Strategies need an explanation to match against"
                }
                description={
                  explanation
                    ? "Either no approved strategy targets the features that pushed this customer's risk up, or strategies have not been created and approved yet."
                    : "Generate the explanation above and the platform will match it against the approved strategy library."
                }
                action={
                  <ButtonLink href="/retention/strategies" variant="primary" size="sm">
                    Go to retention strategies
                  </ButtonLink>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {strategies.slice(0, 4).map((strategy) => (
                <Card key={strategy.id}>
                  <CardHeader
                    title={strategy.title}
                    description={`Triggered by ${strategy.riskDriver}`}
                    actions={
                      <Badge
                        tone={
                          strategy.priority === "critical" || strategy.priority === "high"
                            ? "critical"
                            : strategy.priority === "medium"
                              ? "caution"
                              : "neutral"
                        }
                      >
                        {strategy.priority} priority
                      </Badge>
                    }
                  />
                  <CardBody>
                    <p className="text-sm text-ink-muted">{strategy.description}</p>
                    <div className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
                      <p>
                        <span className="text-2xs tracking-wide text-ink-subtle uppercase">
                          When
                        </span>
                        <br />
                        {strategy.triggeringCondition}
                      </p>
                      <p>
                        <span className="text-2xs tracking-wide text-ink-subtle uppercase">
                          Suggested intervention
                        </span>
                        <br />
                        {strategy.suggestedIntervention}
                      </p>
                      {strategy.matchedShapValue !== null ? (
                        <p className="text-xs text-ink-subtle">
                          This customer&rsquo;s score was pushed up by{" "}
                          <span className="font-medium text-critical">
                            {formatSigned(strategy.matchedShapValue)}
                          </span>{" "}
                          on this feature.
                        </p>
                      ) : null}
                    </div>

                    {canAct ? (
                      <div className="mt-4">
                        {strategy.hasOpenAction ? (
                          <Notice tone="positive">
                            An action for this strategy is already open. Check
                            the retention list to track it.
                          </Notice>
                        ) : (
                          <CreateActionForm
                            customerId={id}
                            strategyId={strategy.id}
                            defaultTitle={strategy.title}
                            defaultDescription={strategy.suggestedIntervention}
                            defaultPriority={
                              strategy.priority === "critical" ? "high" : strategy.priority
                            }
                          />
                        )}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-ink-subtle">
                        Your role does not allow creating retention actions.
                      </p>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}

          {canAct ? (
            <Card>
              <CardHeader
                title="Create an action directly"
                description="For anything not covered by a strategy."
              />
              <CardBody>
                <CreateActionForm customerId={id} />
              </CardBody>
            </Card>
          ) : null}
        </div>
      </Section>

      {/* Retention work already in progress ----------------------------- */}
      <Section
        title="Retention actions"
        description="Work already committed for this customer."
        actions={
          <ButtonLink href={`/retention?customerId=${id}`} size="sm">
            Open in retention
          </ButtonLink>
        }
      >
        <Card>
          {customer.actions.length === 0 ? (
            <EmptyState
              title="No retention actions yet"
              description="Nothing has been committed for this customer. Create an action above when you decide what to do."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Action</Th>
                  <Th>Status</Th>
                  <Th>Priority</Th>
                  <Th>Assigned</Th>
                  <Th align="right">Due</Th>
                </tr>
              </thead>
              <tbody>
                {customer.actions.map((action) => (
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
                      <StatusBadge status={action.status} />
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          action.priority === "high" || action.priority === "critical"
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
                      {action.assignedToName ?? "Unassigned"}
                    </Td>
                    <Td align="right" className="text-xs text-ink-muted">
                      {action.dueDate ? formatDate(action.dueDate, "short") : "—"}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Section>

      {/* Customer record ------------------------------------------------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Customer record">
          <Card>
            <CardBody>
              <DetailList>
                <Detail label="Identifier">{customer.externalId}</Detail>
                <Detail label="Dataset">{customer.datasetName ?? "—"}</Detail>
                <Detail label="Recorded outcome">
                  {customer.observedChurn === null
                    ? "Not recorded in the source file"
                    : customer.observedChurn === 1
                      ? "Churned"
                      : "Stayed"}
                </Detail>
                <Detail label="Open actions">{customer.openActions}</Detail>
              </DetailList>

              {attributes.length > 0 ? (
                <div className="mt-4 border-t border-line pt-3">
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                    Attributes from the source file
                  </h3>
                  <Table>
                    <tbody>
                      {attributes.map(([key, value]) => (
                        <Tr key={key}>
                          <Td className="w-1/2 text-xs text-ink-muted">{key}</Td>
                          <Td className="font-mono text-2xs">
                            {value === null || value === undefined || value === ""
                              ? <span className="text-caution">blank</span>
                              : String(value)}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : null}
            </CardBody>
          </Card>
        </Section>

        <Section
          title="Prediction history"
          description="Every time this customer has been scored, including by which model."
        >
          <Card>
            {customer.predictionHistory.length === 0 ? (
              <EmptyState
                title="Never scored"
                description="This customer has no predictions on record."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th align="right">Probability</Th>
                    <Th>Risk</Th>
                    <Th>Model</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {customer.predictionHistory.map((prediction) => (
                    <Tr key={prediction.id}>
                      <Td align="right">
                        {formatPercent(prediction.churnProbability, 1)}
                      </Td>
                      <Td>
                        <RiskBadge risk={prediction.riskCategory} />
                        {prediction.isActiveModel ? (
                          <span className="ml-1 text-2xs text-ink-faint">
                            active
                          </span>
                        ) : null}
                      </Td>
                      <Td className="text-xs text-ink-muted">
                        {prediction.modelName ?? "—"}
                        {prediction.hasExplanation ? (
                          <span className="ml-1 text-2xs text-positive">
                            explained
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right" className="text-xs text-ink-subtle">
                        {formatRelative(prediction.predictedAt)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </Section>
      </div>
    </>
  );
}
