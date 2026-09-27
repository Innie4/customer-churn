import type { Metadata } from "next";
import Link from "next/link";
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
import { MetricsTable } from "@/components/models/metrics";
import {
  MODEL_TYPE_LABELS,
  MODEL_TYPE_NOTES,
  listModels,
  type ModelType,
} from "@/lib/dal/models";
import { formatDate, formatNumber, formatPercent, formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Models" };
export const dynamic = "force-dynamic";

/**
 * The model history.
 *
 * Every model ever trained, including the failures. Models are never
 * overwritten, so this page is the record of what has actually been run.
 */
export default async function ModelsPage() {
  const models = await listModels();
  const completed = models.filter((model) => model.status === "completed");
  const failed = models.filter((model) => model.status === "failed");
  const active = completed.filter((model) => model.isActive);

  return (
    <>
      <PageHeader
        title="Models"
        description="Every model trained on this platform, with the metrics it actually measured. Nothing here is overwritten: a new run adds a model, it never replaces one."
      />

      {active.length > 0 ? (
        <Section title="Active models">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((model) => (
              <Card key={model.id}>
                <CardBody>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-ink">
                        {model.displayName}
                      </p>
                      <p className="text-2xs text-ink-subtle">
                        Version {model.version ?? "—"}
                      </p>
                    </div>
                    <Badge tone="positive" dot>
                      Active
                    </Badge>
                  </div>
                  {model.testMetrics ? (
                    <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
                      {(
                        [
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
                  <p className="mt-2 text-2xs text-ink-subtle">
                    Activated{" "}
                    {model.activatedAt ? formatRelative(model.activatedAt) : "—"}
                    {model.activatedByName ? ` by ${model.activatedByName}` : ""}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <ButtonLink href={`/models/${model.id}`} size="sm" variant="primary">
                      Detail
                    </ButtonLink>
                    <ButtonLink href={`/models/${model.id}/explanations`} size="sm">
                      Explanations
                    </ButtonLink>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="Comparison"
        description={
          completed.length > 0
            ? `${completed.length} completed model${completed.length === 1 ? "" : "s"}. The best value in each column is marked, but no overall winner is declared.`
            : undefined
        }
      >
        {completed.length > 0 ? (
          <MetricsTable models={completed} />
        ) : (
          <Card>
            <EmptyState
              title="No completed models yet"
              description="Train a model to see measured metrics here. Nothing is shown until a model has actually been evaluated on a held-out test split."
              action={
                <ButtonLink href="/training" variant="primary" size="sm">
                  Go to training
                </ButtonLink>
              }
            />
          </Card>
        )}
      </Section>

      {failed.length > 0 ? (
        <Section
          title="Failed models"
          description="Kept on purpose. A failure with a recorded reason is more useful than a gap in the history."
        >
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th>Stage</Th>
                  <Th>Reason</Th>
                  <Th align="right">Attempted</Th>
                </tr>
              </thead>
              <tbody>
                {failed.map((model) => (
                  <Tr key={model.id}>
                    <Td>
                      <Link
                        href={`/models/${model.id}`}
                        className="font-medium text-action underline-offset-2 hover:underline"
                      >
                        {model.displayName}
                      </Link>
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      {model.errorStage ?? "—"}
                    </Td>
                    <Td className="text-xs text-critical">{model.error}</Td>
                    <Td align="right" className="text-xs text-ink-subtle">
                      {formatRelative(model.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </Section>
      ) : null}

      <Section title="All models">
        <Card>
          {models.length === 0 ? (
            <EmptyState
              title="Nothing has been trained yet"
              description="Preprocess a dataset and start a training run. Three model families are compared under identical conditions."
              action={
                <ButtonLink href="/training" variant="primary" size="sm">
                  Start training
                </ButtonLink>
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th>Status</Th>
                  <Th align="right">Recall</Th>
                  <Th align="right">AUC-ROC</Th>
                  <Th align="right">Trained</Th>
                  <Th align="right">Detail</Th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <Tr key={model.id} className={model.status === "failed" ? "opacity-70" : undefined}>
                    <Td>
                      <Link
                        href={`/models/${model.id}`}
                        className="font-medium text-action underline-offset-2 hover:underline"
                      >
                        {model.displayName}
                      </Link>
                      <p className="text-2xs text-ink-subtle">
                        {MODEL_TYPE_LABELS[model.modelType as ModelType]} ·{" "}
                        {model.version ?? "no version"}
                        {model.isActive ? " · active" : ""}
                      </p>
                    </Td>
                    <Td>
                      <StatusBadge status={model.status} />
                    </Td>
                    <Td align="right">
                      {model.testMetrics
                        ? formatPercent(model.testMetrics.recall, 1)
                        : "—"}
                    </Td>
                    <Td align="right">
                      {model.testMetrics
                        ? model.testMetrics.roc_auc.toFixed(3)
                        : "—"}
                    </Td>
                    <Td align="right" className="text-xs text-ink-subtle">
                      {formatRelative(model.createdAt)}
                    </Td>
                    <Td align="right">
                      <Link
                        href={`/models/${model.id}/performance`}
                        className="text-xs text-action underline underline-offset-2"
                      >
                        Performance
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Section>

      <Section title="The three families">
        <div className="grid gap-4 lg:grid-cols-3">
          {(Object.keys(MODEL_TYPE_LABELS) as ModelType[]).map((type) => (
            <Card key={type}>
              <CardHeader title={MODEL_TYPE_LABELS[type]} />
              <CardBody>
                <p className="text-sm text-ink-muted">
                  {MODEL_TYPE_NOTES[type]}
                </p>
                <p className="mt-3 border-t border-line pt-2 text-xs text-ink-subtle">
                  {formatNumber(
                    completed.filter((model) => model.modelType === type).length,
                  )}{" "}
                  completed,{" "}
                  {formatNumber(
                    models.filter(
                      (model) => model.modelType === type && model.status === "failed",
                    ).length,
                  )}{" "}
                  failed
                  {models.some((model) => model.modelType === type && model.isActive)
                    ? " · one active"
                    : ""}
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      {completed.length > 0 ? (
        <Notice tone="info" title="Choosing a model is a human decision">
          The platform does not promote a model automatically. Read the measured
          metrics, weigh the trade-offs, then activate the model that suits the
          business. The choice, the person who made it and the reason given are
          all recorded.{" "}
          {active.length === 0
            ? " No model is currently active, so predictions cannot be generated yet."
            : null}
        </Notice>
      ) : null}

      {completed.length > 0 ? (
        <p className="mt-4 text-xs text-ink-subtle">
          First model trained {formatDate(completed[completed.length - 1]?.createdAt)}.
        </p>
      ) : null}
    </>
  );
}
