import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GlobalExplanationPanel } from "@/components/models/explanation-panel";
import {
  ButtonLink,
  Card,
  CardBody,
  EmptyState,
  Notice,
  PageHeader,
  Section,
} from "@/components/ui";
import { isUuid } from "@/lib/dal/datasets";
import { getModel } from "@/lib/dal/models";
import { currentActor } from "@/lib/dal/access";

export const metadata: Metadata = { title: "Explanations" };
export const dynamic = "force-dynamic";

/**
 * Global feature importance for a model.
 *
 * This is the company-wide view: which features the model relies on across all
 * customers. Per-customer explanations live on the customer page, because they
 * answer a different question.
 */
export default async function ModelExplanationsPage({
  params,
}: PageProps<"/models/[id]/explanations">) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const [model, actor] = await Promise.all([getModel(id), currentActor()]);
  if (!model) notFound();

  if (model.status !== "completed") {
    return (
      <>
        <PageHeader
          title="Explanations"
          breadcrumb={
            <Link
              href={`/models/${id}`}
              className="text-sm text-action underline-offset-2 hover:underline"
            >
              ← {model.displayName}
            </Link>
          }
        />
        <Card>
          <EmptyState
            title="This model cannot be explained"
            description="A model that did not finish training has no reasoning to open up. Train it first."
            action={
              <ButtonLink href="/training" variant="primary" size="sm">
                Go to training
              </ButtonLink>
            }
          />
        </Card>
      </>
    );
  }

  const canRun = actor?.role === "admin" || actor?.role === "analyst";

  return (
    <>
      <PageHeader
        title="Global feature importance"
        description={`${model.displayName} — which features the model relies on across the customer base, and in which direction.`}
        breadcrumb={
          <Link
            href={`/models/${id}`}
            className="text-sm text-action underline-offset-2 hover:underline"
          >
            ← {model.displayName}
          </Link>
        }
        actions={
          <ButtonLink href="/customers" size="sm">
            Per-customer explanations
          </ButtonLink>
        }
      />

      <Section title="How to read this">
        <Card>
          <CardBody>
            <Notice tone="info" title="Association, not causation">
              A SHAP value describes how the model reached a prediction. It shows
              which features the model leaned on, and in which direction. It does
              not show that a feature caused a customer to churn, and changing a
              feature would not necessarily change the outcome.
            </Notice>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-muted">
              <li>
                Each bar is the <strong>mean absolute SHAP value</strong> for
                that feature: how much it typically moves the prediction, in
                either direction.
              </li>
              <li>
                <span className="font-medium text-critical">Red</span> means the
                feature tends to push risk <em>up</em> on average.{" "}
                <span className="font-medium text-positive">Green</span> means it
                tends to push risk <em>down</em>.
              </li>
              <li>
                A high-ranked feature is one the model depends on. That makes it
                worth reviewing for proxy risk, not an accusation that it is
                unfair.
              </li>
            </ul>
          </CardBody>
        </Card>
      </Section>

      <Section title="Ranked drivers">
        {canRun ? (
          <GlobalExplanationPanel modelId={id} displayName={model.displayName} />
        ) : (
          <Card>
            <EmptyState
              title="Your role cannot run explanations"
              description="Generating global importance scores the model against a sample of customers, which is reserved for analysts and administrators."
            />
          </Card>
        )}
      </Section>

      <Section title="Next step">
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">
              A global ranking says what matters on average. It does not say why
              one particular customer was flagged. Open a customer to see their
              own explanation, then turn the findings into a retention action.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <ButtonLink href="/customers" variant="primary" size="sm">
                Open customers
              </ButtonLink>
              <ButtonLink href={`/models/${id}`} size="sm">
                Back to the model
              </ButtonLink>
            </div>
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
