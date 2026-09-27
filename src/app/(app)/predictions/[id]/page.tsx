import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExplainButton } from "@/components/customers/action-panels";
import {
  Bar,
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
  RiskBadge,
  Section,
  Stat,
  StatGrid,
} from "@/components/ui";
import { isUuid } from "@/lib/dal/datasets";
import { getExplanationForPrediction, getPrediction } from "@/lib/dal/customers";
import { currentActor } from "@/lib/dal/access";
import { formatDate, formatPercent, formatRelative, formatSigned } from "@/lib/format";

export const metadata: Metadata = { title: "Prediction" };
export const dynamic = "force-dynamic";

/**
 * One prediction.
 *
 * Shows the number, what produced it, and — when it exists — the explanation
 * for it. Everything here is traceable: the model version, the thresholds in
 * force, and the timestamp.
 */
export default async function PredictionPage({
  params,
}: PageProps<"/predictions/[id]">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const [prediction, actor] = await Promise.all([
    getPrediction(id),
    currentActor(),
  ]);
  if (!prediction) notFound();

  const explanation = await getExplanationForPrediction(id);
  const canExplain = actor?.role === "admin" || actor?.role === "analyst";
  const maxContribution = explanation
    ? Math.max(
        ...explanation.contributions.map((item) => Math.abs(item.shap_value)),
        0.0001,
      )
    : 1;

  return (
    <>
      <PageHeader
        title={`Prediction for ${prediction.customerName ?? prediction.customerExternalId}`}
        description={
          <>
            Produced by {prediction.modelName ?? "an unknown model"}{" "}
            {prediction.modelVersion
              ? `(version ${prediction.modelVersion})`
              : ""}{" "}
            on {formatDate(prediction.predictedAt, "full")}
            {prediction.isActiveModel ? " · this is the active model" : ""}
          </>
        }
        breadcrumb={
          <Link
            href="/predictions"
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← All predictions
          </Link>
        }
        actions={
          <>
            <RiskBadge risk={prediction.riskCategory} />
            <ButtonLink
              href={`/customers/${prediction.customerId}`}
              size="sm"
              variant="primary"
            >
              Open the customer
            </ButtonLink>
          </>
        }
      />

      <Section title="The prediction">
        <Card>
          <StatGrid>
            <Stat
              label="Churn probability"
              value={formatPercent(prediction.churnProbability, 2)}
              tone={
                prediction.riskCategory === "high"
                  ? "critical"
                  : prediction.riskCategory === "medium"
                    ? "caution"
                    : "positive"
              }
            />
            <Stat label="Risk category" value={prediction.riskCategory} />
            <Stat
              label="Model"
              value={prediction.modelName ?? "—"}
              hint={prediction.modelVersion ?? undefined}
            />
            <Stat
              label="Scored"
              value={formatRelative(prediction.predictedAt)}
              hint={formatDate(prediction.predictedAt, "short")}
            />
          </StatGrid>
          <div className="border-t border-line px-4 py-3">
            <DetailList columns={3}>
              <Detail label="Thresholds in force">
                medium at {formatPercent(prediction.riskThresholds.medium, 0)}, high
                at {formatPercent(prediction.riskThresholds.high, 0)}
              </Detail>
              <Detail label="Scored by">
                {prediction.createdByName ?? "System"}
              </Detail>
              <Detail label="Dataset">{prediction.datasetName ?? "—"}</Detail>
            </DetailList>
          </div>
        </Card>
      </Section>

      <Section
        title="Explanation"
        description="How the model reached this number, factor by factor."
        actions={
          canExplain && !explanation ? (
            <ExplainButton customerId={prediction.customerId} />
          ) : null
        }
      >
        {!explanation ? (
          <Card>
            <EmptyState
              title="No explanation for this prediction yet"
              description="The probability above is valid on its own. An explanation turns it into something a retention manager can act on, by showing which factors the score depends on."
              action={
                canExplain ? (
                  <ExplainButton
                    customerId={prediction.customerId}
                    label="Generate explanation"
                  />
                ) : undefined
              }
            />
          </Card>
        ) : explanation.status === "failed" ? (
          <ErrorState
            title="The explanation could not be generated"
            message={explanation.error ?? "No reason was recorded."}
            nextAction="The prediction remains valid. Generate the explanation again, and check the machine learning service if it keeps failing."
          />
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="In plain language"
                actions={
                  explanation.additivityWarning ? (
                    <Badge tone="caution">Approximate amounts</Badge>
                  ) : (
                    <Badge tone="positive">Adds up exactly</Badge>
                  )
                }
              />
              <CardBody>
                <p className="text-sm text-ink">{explanation.summary}</p>
              </CardBody>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title="Increased the estimate"
                  description="Factors that pushed the predicted risk up."
                />
                <CardBody>
                  {explanation.topIncreasing.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      Nothing pushed this prediction up.
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
                  title="Reduced the estimate"
                  description="Factors that pushed the predicted risk down."
                />
                <CardBody>
                  {explanation.topReducing.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      Nothing pulled this prediction down.
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

            <Notice tone="info" title="Association, not causation">
              {explanation.disclaimer}
            </Notice>

            <Card>
              <CardHeader
                title="Next step"
                description="An explanation is only useful if it changes what you do."
              />
              <CardBody>
                <ButtonLink
                  href={`/customers/${prediction.customerId}`}
                  variant="primary"
                  size="sm"
                >
                  Review retention strategies and act
                </ButtonLink>
              </CardBody>
            </Card>
          </div>
        )}
      </Section>
    </>
  );
}
