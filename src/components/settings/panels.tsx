"use client";

/**
 * Settings controls: risk thresholds and the model defaults panel.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

export function ThresholdsForm({
  thresholds,
}: {
  thresholds: { high: number; medium: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [medium, setMedium] = useState(String(thresholds.medium));
  const [high, setHigh] = useState(String(thresholds.high));
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setResult(null);
    const body = {
      high: Number.parseFloat(high),
      medium: Number.parseFloat(medium),
    };
    startTransition(async () => {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        data?: { thresholds: { high: number; medium: number } };
        error?: { message?: string; nextAction?: string; fields?: Record<string, string> };
      };
      if (response.ok && payload.data) {
        setMedium(String(payload.data.thresholds.medium));
        setHigh(String(payload.data.thresholds.high));
        setResult({
          ok: true,
          message: "Thresholds updated. New predictions will use them.",
        });
        router.refresh();
      } else {
        setResult({
          ok: false,
          message: `${payload.error?.message ?? "The thresholds could not be saved."}${
            payload.error?.nextAction ? ` ${payload.error.nextAction}` : ""
          }`,
        });
      }
    });
  };

  return (
    <form onSubmit={save} className="space-y-3" noValidate>
      {result ? (
        <FormAlert tone={result.ok ? "positive" : "critical"}>
          {result.message}
        </FormAlert>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="High at or above"
          name="high"
          type="number"
          min="0.01"
          max="0.99"
          step="0.01"
          value={high}
          onChange={(event) => setHigh(event.target.value)}
          hint="Proportion, 0 to 1."
        />
        <Field
          label="Medium at or above"
          name="medium"
          type="number"
          min="0.01"
          max="0.99"
          step="0.01"
          value={medium}
          onChange={(event) => setMedium(event.target.value)}
          hint="Must be lower than high."
        />
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save thresholds"}
      </Button>
    </form>
  );
}

export function MlSettingsPanel({
  settings,
}: {
  settings: {
    cvFolds: number;
    randomSeed: number;
    smoteEnabled: boolean;
    testSize: number;
    defaultModelTypes: string[];
  };
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
      {(
        [
          [
            "Cross-validation folds",
            String(settings.cvFolds),
            "Stratified, inside the training split",
          ],
          ["Random seed", String(settings.randomSeed), "Fixes the split and the search"],
          [
            "SMOTE",
            settings.smoteEnabled ? "Enabled" : "Disabled",
            "Training split only, refitted per fold",
          ],
          [
            "Test share",
            `${(settings.testSize * 100).toFixed(0)}%`,
            "Held out from tuning and training",
          ],
          [
            "Model families",
            String(settings.defaultModelTypes.length),
            settings.defaultModelTypes
              .map((type) => type.replace(/_/g, " "))
              .join(", "),
          ],
          ["Scoring metric", "AUC-ROC", "Used for hyperparameter tuning"],
        ] as const
      ).map(([label, value, hint]) => (
        <div key={label}>
          <dt className="text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            {label}
          </dt>
          <dd className="mt-0.5 text-base font-semibold text-ink">{value}</dd>
          <p className="text-2xs text-ink-subtle">{hint}</p>
        </div>
      ))}
    </dl>
  );
}
