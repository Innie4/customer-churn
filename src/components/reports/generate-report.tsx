"use client";

/**
 * Report generation.
 *
 * Choosing a report type drives which scope it needs, so the form asks for a
 * model only where a model is actually required.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/interactive";
import { Field, FormAlert } from "@/components/form";

const KINDS = [
  {
    value: "model_performance",
    label: "Model performance",
    needs: "model" as const,
    note: "Test metrics, confusion matrix, decile lift and hyperparameters.",
  },
  {
    value: "prediction_summary",
    label: "Prediction summary",
    needs: "none" as const,
    note: "Risk distribution and the highest-risk customers.",
  },
  {
    value: "retention_summary",
    label: "Retention summary",
    needs: "none" as const,
    note: "Actions by status and priority, and who owns them.",
  },
  {
    value: "dataset_summary",
    label: "Dataset summary",
    needs: "dataset" as const,
    note: "Structure, target distribution and validation findings.",
  },
  {
    value: "shap_global",
    label: "Global feature importance",
    needs: "model" as const,
    note: "Ranked drivers plus the model-risk review. Measured on demand.",
  },
  {
    value: "audit_trail",
    label: "Audit trail",
    needs: "none" as const,
    note: "Recorded activity, most recent first.",
  },
];

export function GenerateReportPanel({
  datasets,
  models,
}: {
  datasets: { id: string; name: string }[];
  models: { id: string; displayName: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState("model_performance");
  const [format, setFormat] = useState<"pdf" | "csv">("pdf");
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    reportId?: string;
  } | null>(null);

  const selected = KINDS.find((k) => k.value === kind);
  const needs = selected?.needs ?? "none";
  const canSubmit =
    (needs !== "model" || Boolean(modelId)) && (needs !== "dataset" || Boolean(datasetId));

  const run = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setResult(null);
    startTransition(async () => {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          format,
          title: title.trim() || undefined,
          modelResultId: needs === "model" ? modelId : undefined,
          datasetId: needs === "dataset" ? datasetId : undefined,
          limit: 25,
        }),
      });
      const payload = (await response.json()) as {
        data?: { id: string; title: string; sizeBytes: number | null };
        error?: { message?: string; nextAction?: string };
      };
      if (response.ok && payload.data) {
        setResult({
          ok: true,
          message: `Report "${payload.data.title}" generated.`,
          reportId: payload.data.id,
        });
        setTitle("");
        router.refresh();
      } else {
        setResult({
          ok: false,
          message: `${payload.error?.message ?? "The report could not be generated."}${
            payload.error?.nextAction ? ` ${payload.error.nextAction}` : ""
          }`,
        });
      }
    });
  };

  return (
    <form onSubmit={run} className="space-y-3" noValidate>
      {result ? (
        <FormAlert tone={result.ok ? "positive" : "critical"}>
          {result.message}
          {result.ok && result.reportId ? (
            <a
              href={`/api/reports/${result.reportId}/download`}
              className="ml-1 underline underline-offset-2"
            >
              Download it
            </a>
          ) : null}
        </FormAlert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Report"
          name="kind"
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          hint={selected?.note}
        />
        <Field
          label="Format"
          name="format"
          options={[
            { value: "pdf", label: "PDF" },
            { value: "csv", label: "CSV" },
          ]}
          value={format}
          onChange={(event) => setFormat(event.target.value as "pdf" | "csv")}
          hint={
            format === "csv"
              ? "Best for further analysis. Figures are not rounded."
              : "Formatted for reading and sharing."
          }
        />
        <Field
          label="Title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Optional"
          hint="Defaults to the report type and time."
        />
      </div>

      {needs === "model" ? (
        <Field
          label="Model"
          name="modelResultId"
          options={
            models.length > 0
              ? models.map((model) => ({ value: model.id, label: model.displayName }))
              : [{ value: "", label: "No trained models available" }]
          }
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          hint={
            models.length === 0
              ? "Train a model first; this report needs a fitted model to read from."
              : "Global feature importance is measured against this model."
          }
        />
      ) : null}

      {needs === "dataset" ? (
        <Field
          label="Dataset"
          name="datasetId"
          options={
            datasets.length > 0
              ? datasets.map((dataset) => ({ value: dataset.id, label: dataset.name }))
              : [{ value: "", label: "No datasets available" }]
          }
          value={datasetId}
          onChange={(event) => setDatasetId(event.target.value)}
          hint={
            datasets.length === 0
              ? "Upload a dataset first; this report needs one to describe."
              : undefined
          }
        />
      ) : null}

      <Button type="submit" variant="primary" disabled={pending || !canSubmit}>
        {pending ? "Generating…" : "Generate report"}
      </Button>

      {pending ? (
        <p role="status" aria-live="polite" className="text-xs text-ink-subtle">
          Building the report from stored data. Larger reports can take a moment.
        </p>
      ) : null}
    </form>
  );
}
