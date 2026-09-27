"use client";

/**
 * Training run configuration.
 *
 * The model checkboxes default to all three, because comparing them under
 * identical conditions is the point of the study.
 */

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { startTrainingAction, type ActionResult } from "@/app/actions/pipeline";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

interface DatasetOption {
  id: string;
  name: string;
  rowCount: number | null;
  runId: string;
}

const FAMILIES = [
  {
    type: "logistic_regression",
    label: "Logistic Regression",
    note: "The most transparent of the three. Weights are directly readable.",
  },
  {
    type: "random_forest",
    label: "Random Forest",
    note: "Averaged trees. Handles non-linear relationships, harder to read.",
  },
  {
    type: "xgboost",
    label: "XGBoost",
    note: "Sequential boosting. Usually strongest, and hardest to read.",
  },
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      {pending ? "Starting…" : "Start training"}
    </Button>
  );
}

export function StartTrainingForm({
  datasets,
  defaultFolds,
  defaultSeed,
  defaultModelTypes,
}: {
  datasets: DatasetOption[];
  defaultFolds: number;
  defaultSeed: number;
  defaultModelTypes: string[];
}) {
  const [state, action] = useActionState<ActionResult | null, FormData>(
    startTrainingAction,
    null,
  );
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>(
    defaultModelTypes.length > 0
      ? defaultModelTypes
      : FAMILIES.map((family) => family.type),
  );

  useEffect(() => {
    if (state?.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state]);

  const chosen = datasets.find((dataset) => dataset.id === datasetId);
  const runId = chosen?.runId ?? "";

  const toggle = (type: string) => {
    setSelected((current) =>
      current.includes(type)
        ? current.filter((item) => item !== type)
        : [...current, type],
    );
  };

  return (
    <form action={action} className="space-y-4" noValidate>
      {state?.ok && state.message ? (
        <FormAlert tone="positive">{state.message}</FormAlert>
      ) : null}
      {state && !state.ok && state.message ? (
        <FormAlert tone="critical">{state.message}</FormAlert>
      ) : null}

      <input type="hidden" name="preprocessingRunId" value={runId} />

      <Field
        label="Dataset"
        name="datasetId"
        options={[
          { value: "", label: "Choose a dataset" },
          ...datasets.map((dataset) => ({
            value: dataset.id,
            label: `${dataset.name}${
              dataset.rowCount ? ` — ${dataset.rowCount.toLocaleString()} rows` : ""
            }`,
          })),
        ]}
        value={datasetId}
        onChange={(event) => setDatasetId(event.target.value)}
        error={state?.fields?.datasetId}
        hint="Only datasets that have completed preprocessing can be trained on."
      />

      <fieldset>
        <legend className="mb-2 text-xs font-medium text-ink">
          Model families
          <span className="ml-1 text-critical" aria-hidden="true">
            *
          </span>
        </legend>
        <div className="space-y-2">
          {FAMILIES.map((family) => (
            <label
              key={family.type}
              className="flex cursor-pointer items-start gap-2.5 rounded-control border border-line px-3 py-2 hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                name="modelTypes"
                value={family.type}
                checked={selected.includes(family.type)}
                onChange={() => toggle(family.type)}
                className="mt-0.5 size-3.5 rounded border-line-strong text-action"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">
                  {family.label}
                </span>
                <span className="block text-2xs text-ink-subtle">
                  {family.note}
                </span>
              </span>
            </label>
          ))}
        </div>
        {state?.fields?.modelTypes ? (
          <p className="mt-1 text-xs text-critical">
            {state.fields.modelTypes}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Cross-validation folds"
          name="cvFolds"
          type="number"
          min="2"
          max="10"
          defaultValue={defaultFolds}
          error={state?.fields?.cvFolds}
          hint="Stratified folds inside the training split. The documented workflow uses 5."
        />
        <Field
          label="Random seed"
          name="randomSeed"
          type="number"
          min="0"
          defaultValue={defaultSeed}
          error={state?.fields?.randomSeed}
          hint="Fixes the split and the tuning search, so a run can be reproduced."
        />
      </div>

      <Field
        label="Label"
        name="label"
        placeholder="Optional, e.g. Q3 review"
        error={state?.fields?.label}
        hint="Makes this run easier to find in the history."
      />

      <SubmitButton />

      <p className="border-t border-line pt-3 text-xs text-ink-subtle">
        Training runs on the machine learning service and can take a few minutes
        for all three families. You can leave this page and the run will
        continue; its progress is recorded either way.
      </p>
    </form>
  );
}
