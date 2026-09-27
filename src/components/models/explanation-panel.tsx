"use client";

/**
 * Global explanation panel.
 *
 * Computes the importance ranking on demand rather than storing it, because
 * the ranking is a property of the model plus a sample, not a fixed fact. The
 * sample size is exposed because a ranking computed on 50 customers is a
 * different claim from one computed on 1,000.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateGlobalExplanationAction, type ActionResult } from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";
import { Bar, Card, CardBody, CardHeader, Table, Td, Th, Tr } from "@/components/ui";
import { FormAlert } from "@/components/form";
import { formatNumber } from "@/lib/format";

interface FeatureRow {
  rank: number;
  /** The encoded model-input column, e.g. "Contract_Month-to-month". */
  feature: string;
  label: string;
  sourceColumn: string;
  meanAbsShap: number;
  direction: string;
  kind: string;
}

interface ExplanationPayload {
  sampleSize: number;
  note: string;
  features: FeatureRow[];
  disclaimer: string;
}

export function GlobalExplanationPanel({
  modelId,
  displayName,
}: {
  modelId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sampleSize, setSampleSize] = useState("1000");
  const [result, setResult] = useState<ExplanationPayload | null>(null);
  const [error, setError] = useState<ActionResult | null>(null);

  const run = () => {
    setError(null);
    const formData = new FormData();
    formData.set("modelId", modelId);
    formData.set("sampleSize", sampleSize);
    startTransition(async () => {
      const action = await generateGlobalExplanationAction(null, formData);
      if (action.ok) {
        try {
          const payload = (await fetch(
            `/api/models/${modelId}/explanations`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sampleSize: Number(sampleSize) }),
            },
          )) as unknown as { data?: ExplanationPayload };
          if (payload.data) setResult(payload.data);
        } catch {
          // The action already succeeded; a failed read-back is not fatal.
        }
        router.refresh();
      } else {
        setError(action);
      }
    });
  };

  const maxValue = result
    ? Math.max(...result.features.map((feature) => feature.meanAbsShap), 0.0001)
    : 1;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Compute the ranking"
          description="Measured by scoring a sample of customers through the model and attributing each prediction."
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor="sample-size"
                className="mb-1 block text-xs font-medium text-ink"
              >
                Customers to sample
              </label>
              <select
                id="sample-size"
                value={sampleSize}
                onChange={(event) => setSampleSize(event.target.value)}
                className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
              >
                <option value="200">200 — quick look</option>
                <option value="500">500</option>
                <option value="1000">1000 — default</option>
                <option value="2000">2000</option>
              </select>
            </div>
            <Button variant="primary" onClick={run} disabled={pending}>
              {pending ? "Computing…" : "Compute feature importance"}
            </Button>
          </div>

          {error?.message ? (
            <div className="mt-3">
              <FormAlert tone="critical">
                {error.message}
                {error.fields ? (
                  <p className="mt-1 text-xs">{Object.values(error.fields).join(" ")}</p>
                ) : null}
              </FormAlert>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {pending && !result ? (
        <Card>
          <CardBody>
            <p role="status" aria-live="polite" className="text-sm text-ink-muted">
              Scoring {formatNumber(Number(sampleSize))} customers through the
              model and attributing each prediction. This can take a moment.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {result ? (
        <>
          <Card>
            <CardHeader
              title={`Ranked drivers for ${displayName}`}
              description={`Mean absolute SHAP value over ${formatNumber(result.sampleSize)} sampled customers.`}
            />
            <CardBody>
              <p className="mb-4 text-xs text-ink-subtle">{result.note}</p>
              <div>
                {result.features.map((feature) => (
                  <Bar
                    key={feature.feature}
                    label={feature.label}
                    value={feature.meanAbsShap}
                    max={maxValue}
                    display={feature.meanAbsShap.toFixed(4)}
                    tone={
                      feature.direction === "increases_risk"
                        ? "critical"
                        : feature.direction === "reduces_risk"
                          ? "positive"
                          : "neutral"
                    }
                    hint={
                      feature.direction === "increases_risk"
                        ? "Tends to push predicted risk up"
                        : feature.direction === "reduces_risk"
                          ? "Tends to push predicted risk down"
                          : "Pushes risk in both directions depending on the customer"
                    }
                  />
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Feature detail"
              description="The encoded column, the source column it came from, and the direction of the average effect."
            />
            <Table>
              <thead>
                <tr>
                  <Th align="right">Rank</Th>
                  <Th>Feature</Th>
                  <Th>Source column</Th>
                  <Th>Encoding</Th>
                  <Th align="right">Mean |SHAP|</Th>
                  <Th>Direction</Th>
                </tr>
              </thead>
              <tbody>
                {result.features.map((feature) => (
                  <Tr key={feature.feature}>
                    <Td align="right" className="text-ink-faint">
                      {feature.rank}
                    </Td>
                    <Td className="font-medium">{feature.label}</Td>
                    <Td className="font-mono text-2xs text-ink-muted">
                      {feature.sourceColumn}
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      {feature.kind}
                    </Td>
                    <Td align="right">
                      {feature.meanAbsShap.toFixed(5)}
                    </Td>
                    <Td className="text-xs">
                      {feature.direction === "increases_risk" ? (
                        <span className="text-critical">increases risk</span>
                      ) : feature.direction === "reduces_risk" ? (
                        <span className="text-positive">reduces risk</span>
                      ) : (
                        <span className="text-ink-muted">mixed</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <div className="border-t border-line px-4 py-3">
              <p className="text-xs text-ink-subtle">{result.disclaimer}</p>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
