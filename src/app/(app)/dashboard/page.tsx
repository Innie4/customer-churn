import type { Metadata } from "next";
import Link from "next/link";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  EmptyState,
  Notice,
  PageHeader,
  Progress,
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
import { getDashboardOverview } from "@/lib/dal/dashboard";
import { formatPercent, formatRelative, formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

export const dynamic = "force-dynamic";

/**
 * The dashboard.
 *
 * Answers three questions and nothing more: what is the state of the platform,
 * what needs attention, and where do I go next. It deliberately avoids a wall
 * of decorative statistics.
 */
export default async function DashboardPage() {
  const overview = await getDashboardOverview();
  const {
    customers,
    model,
    dataset,
    retention,
    recentPredictions,
    recentActions,
    activity,
  } = overview;

  const isEmpty =
    customers.total === 0 && model.trainedModels === 0 && dataset.id === null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="The operational state of the platform: what has been loaded, what has been trained, and what needs attention."
      />

      {isEmpty ? (
        <Card>
          <EmptyState
            title="Nothing has been loaded yet"
            description={
              <>
                This platform works in one direction: load a churn dataset,
                validate it, preprocess it, train models on it, then read the
                predictions and explanations. Start by uploading a dataset.
              </>
            }
            action={
              <ButtonLink href="/datasets" variant="primary">
                Upload a dataset
              </ButtonLink>
            }
          />
        </Card>
      ) : null}

      {/* Customer base ---------------------------------------------------- */}
      <Section
        title="Customer base"
        description="Counts are from the records loaded from your datasets."
        actions={
          <ButtonLink href="/customers" size="sm">
            Open customer list
          </ButtonLink>
        }
      >
        <Card>
          <StatGrid>
            <Stat
              label="Customers loaded"
              value={customers.total.toLocaleString()}
              hint={customers.unscored > 0 ? `${customers.unscored} not yet scored` : "All scored"}
            />
            <Stat
              label="High risk"
              value={customers.high.toLocaleString()}
              tone={customers.high > 0 ? "critical" : "neutral"}
              hint={formatPercent(activity.highRiskShare, 1) + " of scored"}
            />
            <Stat
              label="Medium risk"
              value={customers.medium.toLocaleString()}
              tone={customers.medium > 0 ? "caution" : "neutral"}
            />
            <Stat
              label="Low risk"
              value={customers.low.toLocaleString()}
              tone={customers.low > 0 ? "positive" : "neutral"}
            />
          </StatGrid>
          {customers.total > 0 ? (
            <div className="border-t border-line px-4 py-3">
              <Progress
                value={activity.coverage * 100}
                label={`${customers.evaluated.toLocaleString()} of ${customers.total.toLocaleString()} customers evaluated`}
              />
            </div>
          ) : null}
        </Card>
      </Section>

      {/* Model and dataset ------------------------------------------------ */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Active model">
          <Card>
            {model.id ? (
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold text-ink">
                      {model.displayName}
                    </p>
                    <p className="text-xs text-ink-subtle">
                      Version {model.version ?? "unknown"}
                    </p>
                  </div>
                  <Badge tone="positive" dot>
                    Active
                  </Badge>
                </div>

                {model.testMetrics ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 sm:grid-cols-4">
                    {(
                      [
                        ["Accuracy", model.testMetrics.accuracy],
                        ["Precision", model.testMetrics.precision],
                        ["Recall", model.testMetrics.recall],
                        ["AUC-ROC", model.testMetrics.roc_auc],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-2xs tracking-wide text-ink-subtle uppercase">
                          {label}
                        </dt>
                        <dd className="text-base font-semibold tabular text-ink">
                          {formatPercent(value, 1)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                <p className="text-xs text-ink-subtle">
                  Activated {model.activatedAt ? formatRelative(model.activatedAt) : "unknown"}
                  {model.activatedByName ? ` by ${model.activatedByName}` : ""}.
                </p>

                <div className="flex flex-wrap gap-2 pt-1">
                  <ButtonLink
                    href={`/models/${model.id}`}
                    size="sm"
                    variant="primary"
                  >
                    Model detail
                  </ButtonLink>
                  <ButtonLink href="/models" size="sm">
                    All models
                  </ButtonLink>
                </div>
              </CardBody>
            ) : (
              <EmptyState
                title="No model is active"
                description={
                  model.trainedModels > 0
                    ? "Models have been trained, but none is serving predictions. Activate one so the platform can score customers."
                    : "Nothing has been trained yet. Preprocess a dataset and start a training run to produce a model."
                }
                action={
                  <ButtonLink
                    href={model.trainedModels > 0 ? "/models" : "/datasets"}
                    variant="primary"
                  >
                    {model.trainedModels > 0 ? "Choose a model" : "Go to datasets"}
                  </ButtonLink>
                }
              />
            )}
          </Card>
        </Section>

        <Section title="Datasets">
          <Card>
            {dataset.id ? (
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold text-ink">
                      {dataset.name}
                    </p>
                    <p className="text-xs text-ink-subtle">
                      {dataset.rowCount
                        ? `${dataset.rowCount.toLocaleString()} rows`
                        : "Row count not yet measured"}
                    </p>
                  </div>
                  <StatusBadge status={dataset.status ?? "unknown"} />
                </div>

                <div className="flex gap-4 border-t border-line pt-3 text-sm">
                  <span className="text-ink-muted">
                    <span className="font-semibold tabular text-ink">
                      {dataset.validated}
                    </span>{" "}
                    validated
                  </span>
                  <span className="text-ink-muted">
                    <span className="font-semibold tabular text-ink">
                      {dataset.invalid}
                    </span>{" "}
                    with errors
                  </span>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <ButtonLink href={`/datasets/${dataset.id}`} size="sm" variant="primary">
                    Open dataset
                  </ButtonLink>
                  <ButtonLink href="/datasets" size="sm">
                    All datasets
                  </ButtonLink>
                </div>
              </CardBody>
            ) : (
              <EmptyState
                title="No dataset loaded"
                description="Upload a churn dataset to begin. The platform measures everything it needs from the file itself."
                action={
                  <ButtonLink href="/datasets" variant="primary">
                    Upload a dataset
                  </ButtonLink>
                }
              />
            )}
          </Card>
        </Section>
      </div>

      {/* Things needing attention ----------------------------------------- */}
      {model.runningRuns > 0 || retention.overdue > 0 || dataset.invalid > 0 ? (
        <Section title="Needs attention">
          <div className="space-y-3">
            {model.runningRuns > 0 ? (
              <Notice tone="info" title={`${model.runningRuns} training run in progress`}>
                Training is running on the machine learning service.{" "}
                <Link
                  href="/training"
                  className="underline underline-offset-2"
                >
                  Watch its progress
                </Link>
                .
              </Notice>
            ) : null}
            {retention.overdue > 0 ? (
              <Notice tone="caution" title={`${retention.overdue} retention action past its follow-up date`}>
                These actions are open and past the date set for them.{" "}
                <Link href="/retention" className="underline underline-offset-2">
                  Review them
                </Link>
                .
              </Notice>
            ) : null}
            {dataset.invalid > 0 ? (
              <Notice tone="critical" title={`${dataset.invalid} dataset with validation errors`}>
                A dataset with errors cannot be preprocessed until they are
                fixed.{" "}
                <Link href="/datasets" className="underline underline-offset-2">
                  Review the validation reports
                </Link>
                .
              </Notice>
            ) : null}
          </div>
        </Section>
      ) : null}

      {/* Recent work ------------------------------------------------------ */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Recent predictions"
          actions={
            <ButtonLink href="/predictions" size="sm">
              View all
            </ButtonLink>
          }
        >
          <Card>
            {recentPredictions.length === 0 ? (
              <EmptyState
                title="No predictions yet"
                description="Activate a model and generate predictions to see customers ranked by risk here."
                action={
                  <ButtonLink href="/models" variant="primary" size="sm">
                    Go to models
                  </ButtonLink>
                }
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th align="right">Probability</Th>
                    <Th>Risk</Th>
                    <Th align="right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {recentPredictions.map((prediction) => (
                    <Tr key={prediction.id}>
                      <Td>
                        <Link
                          href={`/customers/${prediction.customerId}`}
                          className="font-medium text-action underline-offset-2 hover:underline"
                        >
                          {prediction.externalId}
                        </Link>
                        {prediction.hasExplanation ? (
                          <span className="ml-1.5 text-2xs text-ink-faint">
                            explained
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        {formatPercent(prediction.churnProbability, 1)}
                      </Td>
                      <Td>
                        <RiskBadge risk={prediction.riskCategory} />
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

        <Section
          title="Recent retention actions"
          actions={
            <ButtonLink href="/retention" size="sm">
              View all
            </ButtonLink>
          }
        >
          <Card>
            {recentActions.length === 0 ? (
              <EmptyState
                title="No retention actions yet"
                description="Open a customer, review what the model identified, and create an action to work on."
                action={
                  <ButtonLink href="/customers" variant="primary" size="sm">
                    Open a customer
                  </ButtonLink>
                }
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Action</Th>
                    <Th>Status</Th>
                    <Th align="right">Due</Th>
                  </tr>
                </thead>
                <tbody>
                  {recentActions.map((action) => (
                    <Tr key={action.id}>
                      <Td>
                        <Link
                          href={`/retention/${action.id}`}
                          className="font-medium text-action underline-offset-2 hover:underline"
                        >
                          {action.title}
                        </Link>
                        <p className="text-2xs text-ink-subtle">
                          {action.customerExternalId} · {formatRelative(action.createdAt)}
                        </p>
                      </Td>
                      <Td>
                        <StatusBadge status={action.status} />
                      </Td>
                      <Td align="right" className="text-xs">
                        {action.dueDate ? (
                          <span
                            className={
                              new Date(action.dueDate) < new Date() &&
                              action.status !== "completed" &&
                              action.status !== "cancelled"
                                ? "text-critical"
                                : "text-ink-subtle"
                            }
                          >
                            {formatDate(action.dueDate, "short")}
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </Section>
      </div>

      <Section title="Model history">
        <Card>
          <CardBody>
            <div className="flex flex-wrap gap-6 text-sm">
              <span className="text-ink-muted">
                <span className="font-semibold tabular text-ink">
                  {model.trainedModels}
                </span>{" "}
                models trained
              </span>
              <span className="text-ink-muted">
                <span className="font-semibold tabular text-ink">
                  {model.failedModels}
                </span>{" "}
                failed
              </span>
              <span className="text-ink-muted">
                <span className="font-semibold tabular text-ink">
                  {activity.totalPredictions.toLocaleString()}
                </span>{" "}
                predictions generated
              </span>
              <span className="text-ink-muted">
                <span className="font-semibold tabular text-ink">
                  {activity.explanations.toLocaleString()}
                </span>{" "}
                explanations
              </span>
            </div>
            {model.failedModels > 0 ? (
              <p className="mt-3 text-xs text-ink-subtle">
                Failed training runs are kept on purpose.{" "}
                <Link href="/training" className="underline underline-offset-2">
                  See what went wrong
                </Link>
                .
              </p>
            ) : null}
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
