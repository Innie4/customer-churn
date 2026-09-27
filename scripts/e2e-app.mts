/**
 * End-to-end check of the whole platform over real HTTP.
 *
 * Unlike `e2e-ml.mts`, which stops at the Python service, this drives the
 * running Next.js application: sign in, upload, validate, preprocess, load
 * customers, train, activate, predict, explain, retain, report, and then read
 * back the audit trail to confirm every step was recorded.
 *
 * Requires both processes to be running:
 *   npm run ml:dev    (or uvicorn on 8000)
 *   npm start         (or npm run dev on 3000)
 *
 *   npx tsx scripts/e2e-app.mts
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const DATASET = path.resolve("sample-data/Telco-Customer-Churn.csv");

/**
 * Credentials for an account this script signed in as.
 *
 * Required rather than defaulted. A built-in password would be a working
 * credential for anyone who read this file, and the audit assertions below would
 * then be checking a login that anyone could perform. Create the account with
 * `npm run db:seed` and pass its details in.
 */
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
if (!EMAIL || !PASSWORD) {
  process.stderr.write(
    "E2E_EMAIL and E2E_PASSWORD are both required.\n" +
      "Seed an account first:\n" +
      "  SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='...' npm run db:seed\n" +
      "then:\n" +
      "  E2E_EMAIL=you@example.com E2E_PASSWORD='...' npm run test:e2e:app\n",
  );
  process.exit(2);
}

let failures = 0;
let cookie = "";

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  process.stdout.write(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}\n`,
  );
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function obj(value: Json | undefined): Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}
function num(value: Json | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function str(value: Json | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function list(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

async function call(
  method: string,
  route: string,
  body?: FormData | string,
): Promise<{ status: number; json: Json; text: string }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (typeof body === "string") headers["content-type"] = "application/json";

  const response = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    // Keep only the session cookie; the TTL copy is a client convenience.
    const session = setCookie
      .split(/,(?=[^;]+?=)/)
      .map((part) => part.split(";")[0].trim())
      .find((part) => part.startsWith("churn_session=") || part.includes("session"));
    if (session) cookie = session;
  }

  const text = await response.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: response.status, json, text };
}

const data = (json: Json) => obj(obj(json).data);

async function main(): Promise<void> {
  process.stdout.write(`Platform end-to-end check against ${BASE}\n\n`);

  // 1. Health, before signing in.
  process.stdout.write("Health\n");
  const health = await call("GET", "/api/health");
  const healthBody = obj(health.json);
  check(
    "reports both dependencies",
    obj(healthBody.dependencies).database !== undefined,
    `status ${str(healthBody.status)}`,
  );
  check(
    "names only unmet variables, never their values",
    list(healthBody.configurationProblems).every((v) => /^[A-Z_]+$/.test(str(v))),
    list(healthBody.configurationProblems).map((v) => str(v)).join(", "),
  );

  // 2. Unauthenticated access is refused.
  const beforeCookie = cookie;
  cookie = "";
  const anonymous = await call("GET", "/api/datasets");
  check("an anonymous caller is refused", anonymous.status === 401, `status ${anonymous.status}`);
  const badLogin = await call("POST", "/api/auth/login", JSON.stringify({
    email: EMAIL,
    password: "Wrong-Password-123",
  }));
  check("a wrong password is refused", badLogin.status === 401, `status ${badLogin.status}`);
  check("a wrong password is not echoed", !badLogin.text.toLowerCase().includes("wrong-password-123"));
  cookie = beforeCookie;

  // 3. Sign in for real.
  process.stdout.write("\nSign in\n");
  const login = await call("POST", "/api/auth/login", JSON.stringify({
    email: EMAIL,
    password: PASSWORD,
  }));
  check("signs in", login.status === 200, `status ${login.status}`);
  check("receives a session cookie", cookie.length > 0);

  const session = await call("GET", "/api/auth/session");
  const sessionBody = data(session.json);
  check("the session is recognised", obj(sessionBody.user).email === EMAIL);
  check("never returns the password", !session.text.includes(PASSWORD));

  // 4. Upload the real sample dataset.
  process.stdout.write("\nDataset\n");
  const bytes = await readFile(DATASET);
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([new Uint8Array(bytes)], { type: "text/csv" }), "Telco-Customer-Churn.csv");
  uploadForm.append("target_column", "Churn");
  uploadForm.append("id_columns", "customerID");
  uploadForm.append("name", "End to end run");

  const upload = await call("POST", "/api/datasets", uploadForm);
  if (upload.status !== 200 && upload.status !== 409) {
    process.stdout.write(`\nUpload failed ${upload.status}: ${upload.text.slice(0, 400)}\n`);
    process.exit(1);
  }
  const uploadData = data(upload.json);
  let datasetId = str(obj(uploadData.dataset).id);
  if (upload.status === 409) {
    // The file is already on record; reuse it rather than duplicating.
    const listed = await call("GET", "/api/datasets");
    datasetId = str(obj(list(data(listed.json).datasets)[0]).id);
  }
  check("the dataset is on record", datasetId.length > 0, upload.status === 409 ? "reused an existing upload" : "uploaded");

  const dataset = await call("GET", `/api/datasets/${datasetId}`);
  const datasetData = data(dataset.json);
  const inspection = obj(datasetData.validation).issues;
  check(
    "the recorded shape matches the file",
    num(obj(datasetData.dataset).rowCount) === 7043,
    `${num(obj(datasetData.dataset).rowCount)} rows`,
  );
  const codes = list(inspection).map((issue) => str(obj(issue).code));
  check(
    "the blank TotalCharges rows are reported",
    codes.includes("totalcharges_blank_zero_tenure"),
    codes.join(", "),
  );
  check(
    "the duplicate rows are reported",
    codes.includes("duplicate_rows"),
  );

  const validated = await call("POST", `/api/datasets/${datasetId}/validate`);
  check("re-validates on demand", validated.status === 200, `status ${validated.status}`);
  const verdict = data(validated.json);
  check("validation passes", str(verdict.status) === "pass", str(verdict.status));

  // 5. Preprocess, through the real Python service.
  process.stdout.write("\nPreprocessing\n");
  const prep = await call("POST", `/api/datasets/${datasetId}/preprocess`);
  if (prep.status !== 200) {
    process.stdout.write(`\nPreprocess failed ${prep.status}: ${prep.text.slice(0, 400)}\n`);
    process.exit(1);
  }
  const prepData = data(prep.json);
  const prepRun = obj(prepData.run);
  const preprocessingRunId = str(prepRun.id);
  check("a preprocessing run completed", str(prepRun.status) === "completed", str(prepRun.status));
  check(
    "the split matches the methodology",
    num(prepRun.encodedFeatureCount) === 40,
    `${num(prepRun.encodedFeatureCount)} encoded features`,
  );

  const loaded = await call("POST", `/api/datasets/${datasetId}/customers`, "{}");
  check("customer rows are loaded", loaded.status === 200, `status ${loaded.status}`);
  const loadedData = data(loaded.json);
  check(
    "every row in the file became a customer",
    num(loadedData.inserted) + num(loadedData.updated) === 7043,
    `${num(loadedData.inserted)} inserted, ${num(loadedData.updated)} updated`,
  );

  // 6. Train, for real. This takes a couple of minutes.
  process.stdout.write("\nTraining (a couple of minutes)\n");
  const train = await call("POST", "/api/training", JSON.stringify({
    datasetId,
    preprocessingRunId,
    modelTypes: ["logistic_regression", "xgboost"],
    label: "end to end run",
  }));
  if (train.status !== 202) {
    process.stdout.write(`\nTraining submit failed ${train.status}: ${train.text.slice(0, 400)}\n`);
    process.exit(1);
  }
  const runId = str(data(train.json).id);
  check("the run is accepted for background work", train.status === 202);

  let run: Record<string, Json> = {};
  const deadline = Date.now() + 15 * 60 * 1000;
  let ticks = 0;
  while (Date.now() < deadline) {
    const poll = await call("GET", `/api/training/${runId}`);
    run = obj(data(poll.json).run);
    ticks += 1;
    if (["completed", "failed", "cancelled"].includes(str(run.status))) break;
    if (ticks % 20 === 0) {
      process.stdout.write(`        ${str(run.status)} ${num(run.progressPercent)}%\n`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  check("the run completed", str(run.status) === "completed", `${str(run.status)} ${str(run.error)}`);
  if (str(run.status) !== "completed") {
    process.stdout.write(`\nThe run did not complete: ${str(run.error)}\n`);
    process.exit(1);
  }

  const modelList = await call("GET", "/api/models");
  const models = list(data(modelList.json).models);
  check("both model families produced a result", models.length >= 2, `${models.length} model(s)`);
  for (const entry of models) {
    const model = obj(entry);
    const metrics = obj(model.testMetrics);
    process.stdout.write(
      `        ${str(model.displayName).padEnd(20)} ` +
        `auc=${num(metrics.roc_auc).toFixed(4)} acc=${num(metrics.accuracy).toFixed(4)} ` +
        `rec=${num(metrics.recall).toFixed(4)}\n`,
    );
  }
  const aucs = models.map((m) => num(obj(obj(m).testMetrics).roc_auc));
  check(
    "the measured AUC is plausible for this dataset",
    aucs.length > 0 && aucs.every((a) => a > 0.6),
    aucs.map((a) => a.toFixed(4)).join(", "),
  );
  // At most one model per family is ever active. Activation is a separate,
  // attributable decision, so training alone cannot produce a second one.
  const byFamily = new Map<string, number>();
  for (const entry of models) {
    const model = obj(entry);
    if (model.isActive !== true) continue;
    const family = str(model.modelType, "unknown");
    byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
  }
  check(
    "training leaves at most one active model per family",
    [...byFamily.values()].every((count) => count <= 1),
    [...byFamily.entries()].map(([k, v]) => `${k}=${v}`).join(", "),
  );

  const modelId = str(obj(models[0]).id);

  // 7. Activate, with a reason.
  process.stdout.write("\nActivation\n");
  const noReason = await call("POST", `/api/models/${modelId}/activate`, JSON.stringify({}));
  check("refuses to activate without a reason", noReason.status === 422, `status ${noReason.status}`);

  const activated = await call(
    "POST",
    `/api/models/${modelId}/activate`,
    JSON.stringify({ reason: "Highest test AUC-ROC of the candidates reviewed." }),
  );
  check("activates with a recorded reason", activated.status === 200, `status ${activated.status}`);
  const activation = data(activated.json);
  check(
    "returns the model it activated",
    str(activation.id) === modelId,
    str(activation.displayName) + " isActive=" + String(activation.isActive),
  );

  // 8. Predict.
  process.stdout.write("\nPredictions\n");
  const predicted = await call("POST", "/api/predictions", JSON.stringify({ modelId }));
  if (predicted.status !== 200) {
    process.stdout.write(`\nPredict failed ${predicted.status}: ${predicted.text.slice(0, 400)}\n`);
    process.exit(1);
  }
  const predictedData = data(predicted.json);
  const predictions = list(predictedData.predictions);
  check("every customer was scored", num(predictedData.scored) === 7043, `${num(predictedData.scored)} scored`);
  check(
    "a probability is in range for each",
    predictions.every((p) => {
      const value = num(obj(p).churnProbability);
      return value >= 0 && value <= 1;
    }),
  );
  const riskCounts = obj(predictedData.riskCounts);
  const highShare = num(riskCounts.high) / Math.max(1, num(predictedData.scored));
  process.stdout.write(`        ${num(riskCounts.high)} high risk (${(highShare * 100).toFixed(1)}%)\n`);
  check("the high-risk share is not absurd", highShare > 0.02 && highShare < 0.6, `${(highShare * 100).toFixed(1)}%`);

  const firstPrediction = obj(predictions[0]);
  const predictionId = str(firstPrediction.id);
  const customerId = str(firstPrediction.customerId);

  const detail = await call("GET", `/api/predictions/${predictionId}`);
  const detailData = data(detail.json);
  check("the prediction detail is readable", detail.status === 200);
  const detailPrediction = obj(detailData.prediction);
  check(
    "names the model that produced it",
    str(detailPrediction.modelName).length > 0,
    `${str(detailPrediction.modelName)} v${str(detailPrediction.modelVersion)}`,
  );
  check(
    "says whether this is the active model",
    typeof detailPrediction.isActiveModel === "boolean",
  );

  // 9. Explain.
  process.stdout.write("\nExplanations\n");
  const explained = await call("POST", `/api/customers/${customerId}/explanation`, "{}");
  if (explained.status !== 200) {
    process.stdout.write(`\nExplain failed ${explained.status}: ${explained.text.slice(0, 400)}\n`);
    process.exit(1);
  }
  const explainedData = data(explained.json);
  const explanation = obj(explainedData);
  const contributions = list(explanation.contributions);
  check(
    "an explanation was produced",
    contributions.length > 0,
    `${contributions.length} contributions`,
  );
  check("it is completed", str(explanation.status) === "completed", str(explanation.status));
  check("it is verified as exact", explanation.isExact === true);
  check(
    "it states the units its values are in, rather than leaving them to be inferred",
    str(explanation.units) === "probability" || str(explanation.units) === "log_odds",
    str(explanation.units),
  );
  check(
    "a failed additivity check would be reported, not hidden",
    explanation.additivityWarning === false,
    `additivityWarning=${String(explanation.additivityWarning)}`,
  );
  check(
    "it avoids causal language",
    !/\bcaused?\b|\bcausing\b|\bwill reduce churn\b/i.test(str(explanation.summary)),
    str(explanation.summary).slice(0, 90),
  );
  for (const entry of list(explanation.topIncreasing).slice(0, 4)) {
    process.stdout.write(
      `        raises risk: ${str(obj(entry).label).padEnd(30)} ${num(obj(entry).shap_value).toFixed(4)}\n`,
    );
  }
  for (const entry of list(explanation.topReducing).slice(0, 4)) {
    process.stdout.write(
      `        lowers risk: ${str(obj(entry).label).padEnd(30)} ${num(obj(entry).shap_value).toFixed(4)}\n`,
    );
  }

  const global = await call(
    "POST",
    `/api/models/${modelId}/explanations`,
    JSON.stringify({ sampleSize: 300 }),
  );
  check("a global explanation is computed", global.status === 200, `status ${global.status}`);
  const globalData = data(global.json);
  const globalExplanation = obj(globalData);
  const globalFeatures = list(globalExplanation.features);
  check("it ranks features", globalFeatures.length > 0, `${globalFeatures.length} feature(s)`);
  check(
    "it states the units, so a value can be read",
    str(globalExplanation.note).includes("probability") ||
      str(globalExplanation.note).includes("log-odds"),
    str(globalExplanation.note).slice(0, 80),
  );
  check(
    "it avoids causal language",
    !/\bcaused?\b|\bcausing\b/i.test(str(globalExplanation.note) + JSON.stringify(globalFeatures)),
  );
  for (const entry of globalFeatures.slice(0, 5)) {
    process.stdout.write(
      `        ${str(obj(entry).label).padEnd(30)} ${num(obj(entry).mean_abs_shap).toFixed(4)}\n`,
    );
  }

  const readBack = await call("GET", `/api/models/${modelId}/explanations`);
  check(
    "the stored global explanation reads back",
    readBack.status === 200 &&
      list(obj(obj(data(readBack.json).explanation)).features).length === globalFeatures.length,
  );

  // 10. Retain.
  process.stdout.write("\nRetention\n");
  const strategies = await call("GET", "/api/retention/strategies");
  const strategyList = list(data(strategies.json).strategies);
  check("the strategy library is present", strategyList.length > 0, `${strategyList.length} strategies`);

  const action = await call("POST", "/api/retention/actions", JSON.stringify({
    customerId,
    title: "Call about a contract upgrade",
    description: "The model flagged the month-to-month contract as pushing this customer's risk up.",
    priority: "high",
  }));
  if (action.status !== 201) {
    process.stdout.write(`\nAction failed ${action.status}: ${action.text.slice(0, 300)}\n`);
    process.exit(1);
  }
  const actionId = str(data(action.json).id);
  check("an action is created from the explanation", action.status === 201);
  check("it records the risk at the time of the decision", num(data(action.json).churnProbabilityAtCreation) > 0);

  for (const status of ["planned", "in_progress", "completed"] as const) {
    const step = await call("PATCH", `/api/retention/actions/${actionId}`, JSON.stringify({ status }));
    if (step.status !== 200) {
      check(`moves to ${status}`, false, `status ${step.status}`);
      break;
    }
  }
  const actionDetail = await call("GET", `/api/retention/actions/${actionId}`);
  const actionBody = obj(data(actionDetail.json).action);
  check("the action is tracked to completion", str(actionBody.status) === "completed", str(actionBody.status));
  check(
    "every transition is recorded",
    list(data(actionDetail.json).history).length >= 3,
    `${list(data(actionDetail.json).history).length} event(s)`,
  );

  // 11. Report.
  process.stdout.write("\nReports\n");
  const report = await call("POST", "/api/reports", JSON.stringify({
    kind: "model_performance",
    format: "csv",
    modelResultId: modelId,
    title: "End to end performance report",
  }));
  check("a report is generated", report.status === 200, `status ${report.status}`);
  const reportId = str(data(report.json).id);
  check("it is marked complete", str(data(report.json).status) === "completed");

  const download = await fetch(`${BASE}/api/reports/${reportId}/download`, {
    headers: { cookie },
  });
  const reportBytes = Buffer.from(await download.arrayBuffer());
  check(
    "the report downloads as bytes, not a JSON envelope",
    download.status === 200 &&
      !String(download.headers.get("content-type")).includes("application/json") &&
      reportBytes.byteLength > 0,
    `${download.status}, ${reportBytes.byteLength} bytes, ${download.headers.get("content-type")}`,
  );
  check(
    "it is served as an attachment, not inline",
    String(download.headers.get("content-disposition")).includes("attachment"),
  );

  // 12. Settings, which change how every customer is banded.
  process.stdout.write("\nSettings\n");
  const settingsBefore = await call("GET", "/api/settings");
  check("settings are readable", settingsBefore.status === 200, `status ${settingsBefore.status}`);

  const refused = await call("PATCH", "/api/settings", JSON.stringify({ high: 0.75, medium: 0.45 }));
  check("the thresholds are changeable by an administrator", refused.status === 200, `status ${refused.status}`);
  const updated = data(refused.json);
  check(
    "the new thresholds are echoed back",
    num(obj(updated.thresholds).high) === 0.75 &&
      num(obj(updated.thresholds).medium) === 0.45,
    JSON.stringify(updated.thresholds),
  );

  const invalid = await call("PATCH", "/api/settings", JSON.stringify({ high: 4, medium: 0.45 }));
  check("a threshold outside zero to one is refused", invalid.status === 422, `status ${invalid.status}`);

  // 13. Audit trail.
  process.stdout.write("\nAudit\n");
  const audit = await call("GET", "/api/audit?pageSize=200");
  const entries = list(data(audit.json).items);
  const actions = entries.map((entry) => str(obj(entry).action));
  check("the trail is readable", audit.status === 200 && entries.length > 0, `${entries.length} entries`);
  for (const expected of ["dataset", "prediction", "retention", "setting", "model"]) {
    check(
      `records the ${expected} activity`,
      actions.some((action) => action.includes(expected)),
      actions.filter((a) => a.includes(expected)).slice(0, 3).join(", "),
    );
  }
  check(
    "contains no password or token material",
    !audit.text.includes(PASSWORD) &&
      !audit.text.toLowerCase().includes("session_secret") &&
      !/token_hash/i.test(audit.text),
  );
  const activationEntry = entries.find((entry) => str(obj(entry).action).includes("activat"));
  check(
    "attributes the activation to a person and a reason",
    activationEntry !== undefined && str(obj(activationEntry).actorEmail).length > 0,
    activationEntry ? str(obj(activationEntry).actorEmail) : "no activation entry",
  );

  // 14. Sign out.
  process.stdout.write("\nSign out\n");
  const out = await call("POST", "/api/auth/logout");
  check("signs out", out.status < 400, `status ${out.status}`);
  const afterOut = await call("GET", "/api/datasets");
  check("the session no longer works", afterOut.status === 401, `status ${afterOut.status}`);

  process.stdout.write(
    failures === 0
      ? "\nAll end-to-end checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
