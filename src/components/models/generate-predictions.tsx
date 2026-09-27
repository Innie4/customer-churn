"use client";

/**
 * Generate predictions.
 *
 * Scoring is a real operation over every loaded customer, so it reports what it
 * did and warns about anything it could not match rather than failing quietly.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { generatePredictionsAction } from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";
import { FormAlert } from "@/components/form";

interface ModelOption {
  id: string;
  displayName: string;
  modelType: string;
  isActive: boolean;
  status: string;
}

export function GeneratePredictionsPanel({
  models,
  defaultThresholds,
}: {
  models: ModelOption[];
  defaultThresholds: { high: number; medium: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState(
    models.find((model) => model.isActive)?.id ?? models[0]?.id ?? "",
  );
  const [high, setHigh] = useState(String(defaultThresholds.high));
  const [medium, setMedium] = useState(String(defaultThresholds.medium));
  const [result, setResult] = useState<{
    ok: boolean;
    message?: string;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const run = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setResult(null);
    setErrors({});
    const formData = new FormData();
    formData.set("modelId", modelId);
    formData.set("highThreshold", high);
    formData.set("mediumThreshold", medium);

    startTransition(async () => {
      const action = await generatePredictionsAction(null, formData);
      if (action.ok) {
        setResult({ ok: true, message: action.message });
        setOpen(false);
        router.refresh();
      } else {
        setResult({ ok: false, message: action.message });
        if (action.fields) setErrors(action.fields);
      }
    });
  };

  const usable = models.filter((model) => model.status === "completed");

  if (usable.length === 0) {
    return (
      <FormAlert tone="caution">
        No model has finished training, so there is nothing to score with.{" "}
        <Link href="/training" className="underline underline-offset-2">
          Train a model
        </Link>{" "}
        first.
      </FormAlert>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {result ? (
        <FormAlert tone={result.ok ? "positive" : "critical"}>{result.message}</FormAlert>
      ) : null}

      {open ? (
        <Cardish>
          <form onSubmit={run} className="w-80 space-y-3 rounded-card border border-line bg-surface p-3" noValidate>
            <div>
              <label htmlFor="predict-model" className="mb-1 block text-xs font-medium text-ink">
                Model to score with
              </label>
              <select
                id="predict-model"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                className="w-full rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
              >
                {usable.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                    {model.isActive ? " (active)" : ""}
                    {model.modelType.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs font-medium text-ink">
                Risk thresholds
              </legend>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="predict-medium" className="mb-1 block text-2xs text-ink-muted">
                    Medium at or above
                  </label>
                  <input
                    id="predict-medium"
                    type="number"
                    min="0.01"
                    max="0.99"
                    step="0.01"
                    value={medium}
                    onChange={(event) => setMedium(event.target.value)}
                    className="w-full rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-ink tabular"
                  />
                </div>
                <div>
                  <label htmlFor="predict-high" className="mb-1 block text-2xs text-ink-muted">
                    High at or above
                  </label>
                  <input
                    id="predict-high"
                    type="number"
                    min="0.01"
                    max="0.99"
                    step="0.01"
                    value={high}
                    onChange={(event) => setHigh(event.target.value)}
                    className="w-full rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-ink tabular"
                  />
                </div>
              </div>
              {errors.mediumThreshold || errors.thresholds ? (
                <p className="text-2xs text-critical">
                  {errors.mediumThreshold ?? errors.thresholds}
                </p>
              ) : null}
              <p className="text-2xs text-ink-subtle">
                Stored with every prediction, so a risk band can always be
                re-derived from its probability.
              </p>
            </fieldset>

            <div className="flex gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={pending}>
                {pending ? "Scoring customers…" : "Generate predictions"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Cardish>
      ) : (
        <Button variant="primary" onClick={() => setOpen(true)}>
          Generate predictions
        </Button>
      )}
    </div>
  );
}

function Cardish({ children }: { children: React.ReactNode }) {
  return <div className="w-80">{children}</div>;
}
