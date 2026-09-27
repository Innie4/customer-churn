import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivateModelPanel, FlagRiskForm, ResolveRiskButtons } from "@/components/models/model-panels";
import { ConfusionMatrixView, DecileLiftTable } from "@/components/models/metrics";
import {
  Badge,
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
  MODEL_TYPE_LABELS,
  MODEL_TYPE_NOTES,
  getModel,
} from "@/lib/dal/models";
import { formatDate, formatDuration, formatNumber, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Model" };
export const dynamic = "force-dynamic";

/**
 * One model.
 *
 * The measured metrics, the configuration that produced them, the activation
 * record, and the human review of its drivers. Model-risk review is kept
 * deliberately separate from the technical metrics: passing a performance test
 * does not make a model unbiased.
 */
export default async function ModelPage({ params }: PageProps<"/models/[id]">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const [model, actor] = await Promise.all([getModel(id), currentActor()]);
  if (!model) notFound();

  const canManage = actor?.role === "admin" || actor?.role === "analyst";

  return (
    <>
      <PageHeader
        title={model.displayName}
        description={MODEL_TYPE_NOTES[model.modelType]}
        breadcrumb={
          <Link
            href="/models"
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← All models
          </Link>
        }
        actions={
          <>
            <StatusBadge status={model.status} />
            {model.isActive ? <Badge tone="positive" dot>Active</Badge> : null}
            <ButtonLink href={`/models/${id}/performance`} size="sm">
              Performance detail
            </ButtonLink>
            <ButtonLink href={`/models/${id}/explanations`} size="sm">
              Explanations
            </ButtonLink>
          </>
        }
      />

      {model.status === "failed" ? (
        <div className="mb-6">
          <ErrorState
            title="This model did not train"
            message={model.error ?? "No reason was recorded."}
            detail={model.errorStage ? `Failed stage: ${model.errorStage}` : undefined}
            nextAction="Other models in the same run are unaffected. Start a new training run to retry this family."
          />
        </div>
      ) : null}

      <Section title="Configuration">
        <Card>
          <CardBody>
            <DetailList columns={3}>
              <Detail label="Family">{MODEL_TYPE_LABELS[model.modelType]}</Detail>
              <Detail label="Version">{model.version ?? "—"}</Detail>
              <Detail label="Trained">
                {formatDate(model.createdAt, "full")}
              </Detail>
              <Detail label="Training duration">
                {formatDuration(model.trainDurationSeconds)}
              </Detail>
              <Detail label="Encoded features">
                {formatNumber(model.featureCount)}
              </Detail>
              <Detail label="Preprocessing run">
                <code className="font-mono text-2xs">
                  {model.preprocessingVersion?.slice(0, 12) ?? "—"}
                </code>
              </Detail>
            </DetailList>
          </CardBody>
        </Card>
      </Section>

      {model.status === "completed" ? (
        <>
          <Section
            title="Test-set performance"
            description="Measured once, on the held-out split the model never saw during training or tuning."
          >
            <Card>
              <StatGrid>
                <Stat
                  label="Accuracy"
                  value={formatPercent(model.testMetrics?.accuracy, 2)}
                />
                <Stat
                  label="Precision"
                  value={formatPercent(model.testMetrics?.precision, 2)}
                />
                <Stat
                  label="Recall"
                  value={formatPercent(model.testMetrics?.recall, 2)}
                  tone={(model.testMetrics?.recall ?? 0) > 0.6 ? "positive" : "caution"}
                  hint="Churners caught"
                />
                <Stat
                  label="F1-score"
                  value={
                    model.testMetrics
                      ? model.testMetrics.f1.toFixed(4)
                      : "—"
                  }
                />
                <Stat
                  label="AUC-ROC"
                  value={
                    model.testMetrics
                      ? model.testMetrics.roc_auc.toFixed(4)
                      : "—"
                  }
                  hint="Ranking quality"
                />
                <Stat
                  label="CV AUC-ROC"
                  value={
                    typeof model.gridSearch.best_cv_score === "number"
                      ? model.gridSearch.best_cv_score.toFixed(4)
                      : "—"
                  }
                  hint="Higher than test: the training split was balanced"
                />
              </StatGrid>
            </Card>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Confusion matrix">
              <Card>
                <CardBody>
                  <ConfusionMatrixView confusion={model.testConfusion} />
                </CardBody>
              </Card>
            </Section>

            <Section title="Decile lift">
              <Card>
                <CardBody>
                  <DecileLiftTable lift={model.decileLift} />
                </CardBody>
              </Card>
            </Section>
          </div>

          <Section
            title="Hyperparameters"
            description="Selected by grid search on AUC-ROC over stratified cross-validation folds."
          >
            <Card>
              {Object.keys(model.hyperparameters).length === 0 ? (
                <EmptyState
                  title="No hyperparameters recorded"
                  description="This model has no stored configuration, so it cannot be reproduced exactly."
                />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Parameter</Th>
                      <Th>Value</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(model.hyperparameters).map(([key, value]) => (
                      <Tr key={key}>
                        <Td className="font-mono text-xs">{key}</Td>
                        <Td className="font-mono text-xs">{String(value)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </Section>

          <Section title="Activation">
            <Card>
              <CardBody>
                {model.isActive ? (
                  <>
                    <Notice tone="positive" title="This model serves predictions">
                      Activated{" "}
                      {model.activatedAt ? formatDate(model.activatedAt, "full") : "—"}
                      {model.activatedByName ? ` by ${model.activatedByName}` : ""}.
                    </Notice>
                    {model.activationReason ? (
                      <p className="mt-3 border-t border-line pt-3 text-sm text-ink-muted">
                        <span className="font-medium text-ink">Reason given: </span>
                        {model.activationReason}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="text-sm text-ink-muted">
                      This model is not serving predictions. Activating it is a
                      deliberate choice, and the reason you give is recorded in
                      the audit trail.
                    </p>
                    {canManage ? (
                      <div className="mt-4">
                        <ActivateModelPanel
                          modelId={id}
                          displayName={model.displayName}
                        />
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-ink-subtle">
                        Your role does not allow activating a model. Ask an
                        administrator.
                      </p>
                    )}
                  </>
                )}
              </CardBody>
            </Card>
          </Section>
        </>
      ) : null}

      <Section
        title="Model-risk review"
        description="Technical performance does not make a model unbiased. Features that might act as a proxy for a sensitive characteristic, or that are simply questionable, are flagged here for a person to judge."
      >
        <div className="space-y-4">
          <Notice tone="caution" title="A review, not a clearance">
            Passing a performance test says nothing about whether a model treats
            groups fairly. A feature that correlates with age, income or
            location can steer retention offers unfairly without ever appearing
            to. Every feature the model relies on is worth a human look, and
            this is where that judgement is recorded.
          </Notice>

          <Card>
            {model.riskReviews.length === 0 ? (
              <EmptyState
                title="No features flagged yet"
                description="Review the global feature importance, then flag anything that looks like a proxy for a sensitive characteristic or that you are unsure about."
                action={
                  canManage ? (
                    <Link
                      href={`/models/${id}/explanations`}
                      className="text-sm text-action underline underline-offset-2"
                    >
                      Review feature importance
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Feature</Th>
                    <Th>Concern</Th>
                    <Th>Severity</Th>
                    <Th>Status</Th>
                    <Th>Notes</Th>
                    {canManage ? <Th align="right">Resolve</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {model.riskReviews.map((review) => (
                    <Tr key={review.id}>
                      <Td className="font-mono text-xs">{review.feature}</Td>
                      <Td className="text-xs">
                        {review.concernType.replace(/_/g, " ")}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            review.severity === "high"
                              ? "critical"
                              : review.severity === "medium"
                                ? "caution"
                                : "neutral"
                          }
                        >
                          {review.severity}
                        </Badge>
                      </Td>
                      <Td>
                        <StatusBadge status={review.status} />
                      </Td>
                      <Td className="text-xs text-ink-muted">
                        {review.notes ?? "—"}
                        {review.reviewedByName ? (
                          <span className="block text-2xs text-ink-subtle">
                            {review.status} by {review.reviewedByName}
                          </span>
                        ) : null}
                      </Td>
                      {canManage ? (
                        <Td align="right">
                          <ResolveRiskButtons
                            reviewId={review.id}
                            modelId={id}
                          />
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {canManage ? (
            <Card>
              <CardHeader
                title="Flag a feature"
                description="Add a feature to the review list with a concern type and a severity."
              />
              <CardBody>
                <FlagRiskForm modelId={id} />
              </CardBody>
            </Card>
          ) : null}
        </div>
      </Section>
    </>
  );
}
