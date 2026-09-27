/**
 * End-to-end check of the ML service over real HTTP.
 *
 * Drives the full pipeline against the live FastAPI process with the real sample
 * dataset: inspect, preprocess, train, score, explain locally and globally, and
 * fetch a chart. Then checks that the failure paths return errors rather than
 * plausible-looking output.
 *
 *   npx tsx scripts/e2e-ml.mts
 *
 * Requires the service to be running, with ML_SERVICE_API_KEY set to match.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.ML_SERVICE_URL ?? "http://127.0.0.1:8000";
const KEY = process.env.ML_SERVICE_API_KEY ?? "";
const DATASET = path.resolve("sample-data/Telco-Customer-Churn.csv");
const DATASET_NAME = "Telco-Customer-Churn.csv";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  process.stdout.write(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}\n`,
  );
};

const headers = (): Record<string, string> =>
  KEY ? { "x-ml-api-key": KEY } : {};

/** A JSON value, as the service sends it. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Narrow a value to a JSON object, or an empty one. */
function obj(value: Json | undefined): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

/** Narrow to a number, with a fallback for anything else. */
function num(value: Json | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Narrow to a string, with a fallback for anything else. */
function str(value: Json | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Narrow to an array, or an empty one. */
function list(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}


let csvBytes: Buffer;

/** Build a multipart body with the dataset attached as `file`. */
function form(fields: Record<string, string | number | boolean>): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(csvBytes)], { type: "text/csv" }),
    DATASET_NAME,
  );
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  return form;
}

/** POST a multipart body, tolerating a busy server. */
async function call(
  route: string,
  fields: Record<string, string | number | boolean>,
  attempts = 3,
): Promise<{ status: number; json: Json }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${route}`, {
        method: "POST",
        headers: headers(),
        body: form(fields),
      });
      const text = await response.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      return { status: response.status, json };
    } catch (error) {
      // The service computes SHAP synchronously, so a request issued while it
      // is busy can be refused at the socket. That is a real characteristic of
      // the service, not a flake, so it is retried rather than hidden.
      lastError = error;
      process.stdout.write(
        `        (retry ${attempt}/${attempts}: ${(error as Error).message})\n`,
      );
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

async function get(route: string): Promise<{ status: number; json: Json }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${route}`, { headers: headers() });
      const text = await response.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      return { status: response.status, json };
    } catch (error) {
      lastError = error;
      process.stdout.write(
        `        (poll retry ${attempt}/4: ${(error as Error).message})\n`,
      );
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

async function main() {
  process.stdout.write(`ML service end-to-end check against ${BASE}\n\n`);

  csvBytes = await readFile(DATASET);
  process.stdout.write(`Dataset: ${DATASET} (${csvBytes.length} bytes)\n\n`);

  const health = await get("/health");
  const healthBody = obj(health.json);
  check(
    "service is healthy",
    health.status === 200 && str(healthBody.status) === "ok",
  );
  process.stdout.write(
    `        ${JSON.stringify(obj(healthBody.library_versions))}\n`,
  );

  // 1. Inspect
  process.stdout.write("\nInspect\n");
  const inspect = await call("/v1/datasets/inspect", {
    target_column: "Churn",
    preview_rows: 5,
  });
  if (inspect.status !== 200) {
    process.stdout.write(`\nInspect failed: ${JSON.stringify(inspect.json)}\n`);
    return;
  }
  const report = obj(inspect.json);
  check(
    "row count is the full dataset",
    num(report.row_count) === 7043,
    `got ${num(report.row_count)}`,
  );
  check(
    "column count is 21",
    num(report.column_count) === 21,
    `got ${num(report.column_count)}`,
  );
  const issues = list(report.issues);
  const aboutTotalCharges = issues.filter((issue) => {
    const record = obj(issue);
    return `${str(record.code)} ${str(record.message)} ${str(record.column)}`
      .toLowerCase()
      .includes("totalcharges");
  });
  check(
    "the blank TotalCharges rows are reported, not hidden",
    aboutTotalCharges.length > 0,
    `${aboutTotalCharges.length} finding(s)`,
  );
  check(
    "duplicate rows are reported",
    issues.some((issue) =>
      str(obj(issue).message).toLowerCase().includes("duplicate"),
    ),
    "the sample dataset contains 22 duplicate rows",
  );
  check(
    "the class balance is reported as a measured rate",
    typeof report.target_positive_rate === "number",
    `positive rate ${num(report.target_positive_rate)}`,
  );
  process.stdout.write(
    `        positive rate: ${num(report.target_positive_rate).toFixed(6)}\n`,
  );
  for (const issue of issues) {
    const record = obj(issue);
    process.stdout.write(
      `        [${str(record.severity)}] ${str(record.code)}: ${str(record.message)}\n`,
    );
  }

  // 2. Preprocess
  process.stdout.write("\nPreprocess\n");
  const prep = await call("/v1/datasets/preprocess", {
    target_column: "Churn",
    test_size: 0.2,
    stratify: true,
    apply_smote: true,
    random_seed: 42,
  });
  if (prep.status !== 200) {
    process.stdout.write(`\nPreprocess failed: ${JSON.stringify(prep.json)}\n`);
    return;
  }
  const pre = obj(prep.json);
  const split = obj(pre.split);
  const encoded = list(pre.encoded_features);
  check(
    "train rows are the 80% split",
    num(split.train_rows) === 5634,
    JSON.stringify(split),
  );
  check(
    "test rows are the 20% split",
    num(split.test_rows) === 1409,
    JSON.stringify(split),
  );
  check(
    "features are the 40 documented columns",
    encoded.length === 40,
    `${encoded.length} feature(s)`,
  );
  const preprocessingId = str(pre.preprocessing_id);
  check(
    "the fitted transformer is stored for later scoring",
    preprocessingId.length > 0,
    preprocessingId,
  );
  process.stdout.write(
    `        split ${JSON.stringify(split)}  resample ${JSON.stringify(obj(pre.resample))}\n`,
  );
  for (const step of list(pre.steps)) {
    const record = obj(step);
    process.stdout.write(
      `        step: ${str(record.step, "?")} — ${str(record.description)}\n`,
    );
  }

  // 3. Train
  process.stdout.write("\nTrain (a couple of minutes)\n");
  const train = await post2("/v1/training/runs", {
    preprocessing_id: preprocessingId,
    model_types: ["logistic_regression", "xgboost"],
    cv_folds: 3,
    random_seed: 42,
    run_label: "end-to-end check",
  });
  check(
    "training run is accepted for background processing",
    [200, 201, 202].includes(train.status),
    `status ${train.status} (202 Accepted is correct: training is a background job)`,
  );
  const runId = str(obj(train.json).run_id);
  check("a run id was returned", runId.length > 0, runId);
  if (!runId) {
    process.stdout.write(`\n${JSON.stringify(train.json)}\n`);
    return;
  }

  let run: Record<string, Json> = {};
  const deadline = Date.now() + 15 * 60 * 1000;
  let ticks = 0;
  while (Date.now() < deadline) {
    const status = await get(`/v1/training/runs/${runId}`);
    run = obj(status.json);
    ticks += 1;
    if (["completed", "failed", "cancelled"].includes(str(run.status))) break;
    if (ticks % 8 === 0) {
      process.stdout.write(
        `        ${str(run.status)} ${num(run.progress_percent)}%\n`,
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  check("training run completed", run?.status === "completed", `status ${run?.status} ${run?.error ?? ""}`);
  if (run?.status !== "completed") {
    process.stdout.write(`\n${JSON.stringify(run).slice(0, 600)}\n`);
    return;
  }

  const results = list(run.models);
  check("both algorithms produced a result", results.length === 2, `${results.length} result(s)`);
  let modelId = "";
  for (const entry of results) {
    const r = obj(entry);
    const m = obj(obj(r.test).metrics);
    // The model id is the artefact name, which is what the prediction routes
    // address. There is no separate id field in the run payload.
    const id = String(r.artifact_path ?? "").replace(/\.joblib$/i, "").split(/[\\/]/).pop() ?? "";
    process.stdout.write(
      `        ${String(r.model_type ?? "?").padEnd(20)} ` +
        `cv=${num(obj(r.grid_search).best_cv_score).toFixed(4)} ` +
        `test_auc=${num(m.roc_auc).toFixed(4)} ` +
        `acc=${num(m.accuracy).toFixed(4)} ` +
        `prec=${num(m.precision).toFixed(4)} ` +
        `rec=${num(m.recall).toFixed(4)} ` +
        `f1=${num(m.f1).toFixed(4)}\n`,
    );
    if (!modelId) modelId = id;
  }
  const records = results.map(obj);
  check(
    "every requested algorithm completed",
    records.length > 0 && records.every((r) => str(r.status) === "completed"),
    records.map((r) => `${str(r.model_type)}=${str(r.status)}`).join(", "),
  );
  check(
    "validation and test metrics are reported separately",
    records.every(
      (r) =>
        str(obj(r.validation).split) === "validation_cv" &&
        str(obj(r.test).split) === "test",
    ),
    "the two numbers must not be the same figure under two labels",
  );
  check(
    "decile lift was computed",
    records.every((r) => list(obj(r.decile_lift).rows).length === 10),
  );
  const aucs = records.map((r) => num(obj(obj(r.test).metrics).roc_auc));
  check(
    "test AUC-ROC is plausible for this dataset",
    aucs.length > 0 && aucs.every((a) => a > 0.6),
    `aucs ${aucs.map((a) => a.toFixed(4)).join(", ")}`,
  );
  check("a model id was returned", modelId.length > 0, modelId);
  check(
    "every model reports a confusion matrix and ROC curve",
    records.every((r) => obj(r.test).confusion_matrix && obj(r.test).roc),
  );

  // 4. Score
  process.stdout.write("\nScore\n");
  const predict = await call(`/v1/models/${modelId}/predict`, {
    high_threshold: 0.7,
    medium_threshold: 0.4,
  });
  if (predict.status !== 200) {
    process.stdout.write(`\nPredict failed: ${JSON.stringify(predict.json)}\n`);
    return;
  }
  const predictions = list(obj(predict.json).predictions);
  check("predictions were produced", predictions.length === 7043, `${predictions.length} row(s)`);
  const scored = predictions.map(obj);
  check(
    "every probability is in [0, 1]",
    scored.every((p) => {
      const probability = num(p.churn_probability);
      return probability >= 0 && probability <= 1;
    }),
  );
  check(
    "every prediction has a risk band",
    scored.every((p) => ["low", "medium", "high"].includes(str(p.risk_category))),
  );
  check(
    "the predicted class follows the 0.5 decision threshold, not a risk band",
    scored.every((p) => {
      const probability = num(p.churn_probability);
      return num(p.predicted_label) === (probability >= 0.5 ? 1 : 0);
    }),
  );
  const flagged = predictions.filter(
    (p) => str(obj(p).risk_category) === "high",
  ).length;
  const rate = flagged / Math.max(1, predictions.length);
  process.stdout.write(
    `        ${flagged} high-risk (${(rate * 100).toFixed(1)}%) — base rate is 26.5%\n`,
  );
  check(
    "the high-risk share is not absurd",
    rate > 0.02 && rate < 0.6,
    `${(rate * 100).toFixed(1)}%`,
  );

  // 5. Local SHAP
  process.stdout.write("\nExplain one customer\n");
  const cap = await get(`/v1/models/${modelId}/explanation-capability`);
  check("explanation capability is reported", cap.status === 200, `status ${cap.status}`);
  process.stdout.write(`        ${JSON.stringify(cap.json).slice(0, 240)}\n`);

  const local = await call(`/v1/models/${modelId}/explanations/local`, {
    row_index: 0,
    top_n: 6,
    render_plot: true,
  });
  if (local.status !== 200) {
    process.stdout.write(`\nLocal SHAP failed: ${JSON.stringify(local.json)}\n`);
    return;
  }
  const explanation = obj(local.json);
  const contributions = list(explanation.all_contributions);
  check(
    "contributions were returned",
    contributions.length > 0,
    `${contributions.length} contribution(s)`,
  );
  check(
    "additivity is reported as data, not only as prose",
    typeof explanation.additive === "boolean",
    `additive=${String(explanation.additive)}`,
  );
  const predicted = num(explanation.churn_probability);
  const base = num(explanation.base_value);
  const summed = contributions.reduce<number>(
    (acc, contribution) => acc + num(obj(contribution).shap_value),
    base,
  );
  const reconstructed = num(explanation.reconstructed_probability);
  process.stdout.write(
    `        base ${base.toFixed(6)} + sum(shap) ${(summed - base).toFixed(6)} = ` +
      `${summed.toFixed(6)} in ${
        str(explanation.model_type) === "logistic_regression"
          ? "log-odds"
          : "probability"
      }\n`,
  );

  // Linear SHAP works in log-odds, so the reconstruction is compared in that
  // space rather than against the probability directly. Comparing the wrong
  // units is how a correct explanation gets reported as a broken one.
  const space = str(explanation.model_type) === "logistic_regression"
    ? Math.log(predicted / (1 - predicted))
    : predicted;
  const gap = Math.abs(summed - space);
  check(
    "the contributions reconstruct the prediction",
    gap < 0.02,
    `gap ${gap.toFixed(6)} (base + sum(shap) vs the model's own output)`,
  );
  check(
    "the service reports the same additivity verdict",
    explanation.additive === (gap < 0.02),
    `additive=${String(explanation.additive)} gap=${gap.toFixed(6)}`,
  );
  check(
    "the rebuilt probability is reported alongside",
    typeof explanation.reconstructed_probability === "number",
    `reconstructed ${reconstructed.toFixed(6)} vs predicted ${predicted.toFixed(6)}`,
  );
  check(
    "the explanation carries the non-causal disclaimer",
    str(explanation.disclaimer).length > 0,
  );
  for (const contribution of contributions.slice(0, 6)) {
    const record = obj(contribution);
    process.stdout.write(
      `        ${str(record.feature, "?").padEnd(32)} ${num(record.shap_value).toFixed(5)}\n`,
    );
  }

  // 6. Global SHAP
  process.stdout.write("\nExplain the model\n");
  const global = await call(`/v1/models/${modelId}/explanations/global`, {
    sample_size: 200,
    render_plots: true,
  });
  if (global.status !== 200) {
    process.stdout.write(`\nGlobal SHAP failed: ${JSON.stringify(global.json)}\n`);
    return;
  }
  const globalBody = obj(global.json);
  const features = list(globalBody.features).map(obj);
  check(
    "global features were returned",
    features.length > 0,
    `${features.length} feature(s)`,
  );
  const importance = (f: Record<string, Json>) => num(f.mean_abs_shap);
  const ordered = features.every(
    (f, index) => index === 0 || importance(features[index - 1]) >= importance(f),
  );
  check("global features are ordered by influence", ordered);
  for (const f of features.slice(0, 8)) {
    process.stdout.write(
      `        ${str(f.feature, "?").padEnd(34)} ${importance(f).toFixed(5)}\n`,
    );
  }
  const top = str(features[0]?.feature).toLowerCase();
  check(
    "a business lever leads, as the study found",
    ["contract", "tenure", "month", "charge"].some((k) => top.includes(k)),
    `top feature is "${str(features[0]?.feature)}"`,
  );
  check(
    "the global explanation carries the non-causal disclaimer",
    str(globalBody.disclaimer).length > 0,
  );
  const chartName = String(globalBody.beeswarm_plot_path ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  const chart = await fetch(`${BASE}/v1/plots/${encodeURIComponent(chartName ?? "")}`, {
    headers: KEY ? { "x-ml-api-key": KEY } : {},
  });
  const chartBytes = Buffer.from(await chart.arrayBuffer());
  check(
    "the beeswarm chart is servable as PNG bytes",
    chart.status === 200 &&
      chartBytes.length > 1000 &&
      chartBytes.subarray(1, 4).toString() === "PNG",
    `status ${chart.status}, ${chartBytes.length} bytes`,
  );

  // 7. Charts
  process.stdout.write("\nArtefacts\n");
  const roc = await fetch(`${BASE}/v1/training/runs/${runId}/roc-plot`, {
    headers: headers(),
  });
  check("roc plot returns 200", roc.status === 200, `status ${roc.status}`);
  const rocBody = obj(JSON.parse(await roc.text()));
  check(
    "the roc route names the file it wrote",
    str(rocBody.path).endsWith(".png"),
    str(rocBody.path),
  );

  // The application cannot read the service's disk, so the bytes have to be
  // fetchable too. This is what makes a chart displayable at all.
  const rocImage = await fetch(
    `${BASE}/v1/training/runs/${runId}/roc-plot?image=true`,
    { headers: headers() },
  );
  const plot = Buffer.from(await rocImage.arrayBuffer());
  check(
    "the roc plot is served as PNG bytes",
    rocImage.status === 200 &&
      plot.length > 1000 &&
      plot.subarray(1, 4).toString() === "PNG",
    `status ${rocImage.status}, ${plot.length} bytes, magic "${plot.subarray(1, 4).toString()}"`,
  );

  // 8. Failure paths
  process.stdout.write("\nFailure paths\n");

  // An explicitly named target that is absent is reported by inspection, and
  // refused by preprocessing. Reporting rather than refusing is deliberate:
  // inspection exists to tell the person what is wrong with the file.
  const badTarget = await call("/v1/datasets/inspect", {
    target_column: "NotAColumn",
    preview_rows: 5,
  });
  const badTargetIssues = list(obj(badTarget.json).issues).map(obj);
  check(
    "inspection names the missing target column instead of guessing",
    badTarget.status === 200 &&
      badTargetIssues.some(
        (issue) =>
          str(issue.code) === "target_missing" &&
          str(issue.severity) === "error" &&
          str(issue.message).includes("NotAColumn"),
      ),
    `status ${badTarget.status}, codes: ${badTargetIssues.map((i) => str(i.code)).join(", ")}`,
  );

  const badTargetPreprocess = await call("/v1/datasets/preprocess", {
    target_column: "NotAColumn",
  });
  check(
    "preprocessing refuses the same file",
    badTargetPreprocess.status >= 400,
    `status ${badTargetPreprocess.status}`,
  );

  // Prose is still a valid single-column CSV, so this is a file with no target
  // rather than an unreadable one. The finding is what matters.
  const notCsv = new FormData();
  notCsv.append(
    "file",
    new Blob([new TextEncoder().encode("these are not, remotely, a csv")], {
      type: "text/plain",
    }),
    "notes.txt",
  );
  const notCsvRes = await fetch(`${BASE}/v1/datasets/inspect`, {
    method: "POST",
    headers: headers(),
    body: notCsv,
  });
  const notCsvBody = obj(JSON.parse(await notCsvRes.text()));
  const notCsvIssues = list(notCsvBody.issues).map(obj);
  check(
    "a file with no target column is reported, not silently accepted",
    notCsvIssues.some(
      (issue) =>
        (str(issue.code) === "target_missing" || str(issue.code) === "no_columns") &&
        str(issue.severity) === "error",
    ),
    `status ${notCsvRes.status}, codes: ${notCsvIssues.map((i) => str(i.code)).join(", ")}`,
  );

  const unknownModel = await get(
    "/v1/models/00000000-0000-0000-0000-000000000000/explanation-capability",
  );
  check(
    "an unknown model id is an error, not a crash",
    unknownModel.status >= 400,
    `status ${unknownModel.status}`,
  );

  // A plot name that tries to escape the plot directory must not be served.
  const traversal = await fetch(
    `${BASE}/v1/plots/${encodeURIComponent("..\\..\\requirements.txt")}`,
    { headers: headers() },
  );
  check(
    "a plot name cannot escape the plot directory",
    traversal.status === 404,
    `status ${traversal.status}`,
  );

  // A background run that cannot succeed is accepted, then reported as failed
  // with a reason. The caller has something to poll and the poll tells the
  // truth, which is more useful than a run that silently disappears.
  const badPreprocessing = await post2("/v1/training/runs", {
    preprocessing_id: "00000000-0000-0000-0000-000000000000",
    model_types: ["logistic_regression"],
  });
  const badRunId = str(obj(badPreprocessing.json).run_id);
  let badRun: Record<string, Json> = {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    badRun = obj((await get(`/v1/training/runs/${badRunId}`)).json);
    if (["completed", "failed", "cancelled"].includes(str(badRun.status))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check(
    "an impossible run is recorded as failed, with a reason",
    str(badRun.status) === "failed" && str(badRun.error).length > 0,
    `status ${str(badRun.status)}, error: ${str(badRun.error).slice(0, 80)}`,
  );

  process.stdout.write(
    failures === 0 ? "\nAll end-to-end checks passed.\n" : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** POST a JSON body, for the endpoints that do not take a file. */
async function post2(
  route: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: response.status, json };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
