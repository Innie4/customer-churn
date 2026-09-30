/**
 * Walk every page of the running application in simulated mode.
 *
 * Signs in, discovers the real ids from the list endpoints, then requests each
 * page and reports its status, whether it rendered data rather than an empty
 * state, and whether the simulated-mode banner is present.
 *
 * This checks that the pages are reachable and populated. It is not a
 * substitute for a browser: it confirms the server rendered each route, not
 * that the styles or the client-side interactions look right.
 *
 *   npm run demo:dev
 *   npx tsx scripts/check-demo-pages.mts
 */

import { existsSync } from "node:fs";
import path from "node:path";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";

let cookie = "";

/**
 * Sign in as the administrator demo account, using the same one-click endpoint
 * the sign-in page uses. That keeps this check honest: if one-click sign-in
 * breaks, every page check fails rather than silently passing.
 */
async function signIn(): Promise<void> {
  const response = await fetch(`${BASE}/api/auth/demo-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "admin" }),
  });
  if (!response.ok) {
    throw new Error(`demo sign-in failed: ${response.status} ${await response.text()}`);
  }

  // `getSetCookie` is the tidy API but is not available in every Node build, so
  // the raw header is parsed as a fallback.
  const raw = (
    response.headers.getSetCookie?.() ??
    (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : [])
  ).flatMap((value) => value.split(/,(?=\s*\w+=)/));

  const session = raw.find((value) => value.trim().startsWith("churn_session="));
  if (!session) throw new Error(`no session cookie in: ${JSON.stringify(raw)}`);
  cookie = session.trim().split(";")[0]!;
  process.stdout.write("signed in as the demo administrator\n");
}

/** Fail early with a useful message rather than a confusing null dereference. */
function requireCredentialFile(): void {
  const file = path.join(process.cwd(), ".data", "demo-credentials.txt");
  if (!existsSync(file)) {
    throw new Error(`No demo world at ${file}. Build one with: npm run demo:seed`);
  }
}

async function json(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie } });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return (await response.json()) as unknown;
}

/** A row from a list endpoint. The shape varies, so the fields are optional. */
interface Row {
  id?: string;
  status?: string;
  isActive?: boolean;
  modelRunId?: string;
  [key: string]: unknown;
}

/**
 * Pull the rows out of a list response.
 *
 * The list endpoints are not uniform: some return `data.models`, some
 * `data.items` with pagination alongside, so the first array found under the
 * envelope is used rather than a hard-coded key per endpoint.
 */
const rows = (body: unknown): Row[] => {
  if (Array.isArray(body)) return body as Row[];
  const data = (body as { data?: unknown })?.data;
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of [
      "items",
      "models",
      "datasets",
      "reports",
      "strategies",
      "actions",
      "customers",
      "predictions",
    ]) {
      if (Array.isArray(record[key])) return record[key] as Row[];
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
        return value as Row[];
      }
    }
  }
  return [];
};

requireCredentialFile();

const ids: Record<string, string | undefined> = {};

await signIn();

ids.dataset = rows(await json("/api/datasets"))[0]?.id;

const modelList = rows(await json("/api/models"));
ids.model = modelList.find((model) => model.isActive)?.id ?? modelList[0]?.id;
// The training-runs endpoint is POST-only, so the run is read off a model,
// which carries the id of the run that produced it.
ids.run = modelList[0]?.modelRunId;

ids.prediction = rows(await json("/api/predictions?limit=5"))[0]?.id;
ids.customer = rows(await json("/api/customers?limit=5"))[0]?.id;
ids.report = rows(await json("/api/reports"))[0]?.id;

const strategyList = rows(await json("/api/retention/strategies"));
ids.strategy = strategyList.find((s) => s.status === "approved")?.id ?? strategyList[0]?.id;
ids.action = rows(await json("/api/retention/actions"))[0]?.id;

process.stdout.write(`discovered ids: ${JSON.stringify(ids)}\n\n`);

interface Page {
  path: string;
  /** Proves the page found data rather than rendering an empty state. */
  expect: RegExp;
  label: string;
}

const pages: Page[] = [
  { path: "/dashboard", expect: /churn|customer|model|risk/i, label: "dashboard" },
  { path: "/datasets", expect: /Telco|row|dataset/i, label: "datasets list" },
  { path: `/datasets/${ids.dataset}`, expect: /Telco|row|column/i, label: "dataset detail" },
  { path: `/datasets/${ids.dataset}/validation`, expect: /issue|column|row|valid/i, label: "dataset validation" },
  { path: `/datasets/${ids.dataset}/preview`, expect: /customer|contract|tenure/i, label: "dataset preview" },
  { path: `/datasets/${ids.dataset}/preprocessing`, expect: /step|split|smote|encode|train/i, label: "preprocessing" },
  { path: "/models", expect: /Logistic|XGBoost|Random Forest|model/i, label: "models list" },
  { path: `/models/${ids.model}`, expect: /AUC|accuracy|recall|SHAP/i, label: "model detail" },
  { path: `/models/${ids.model}/performance`, expect: /AUC|accuracy|recall|confusion|decile/i, label: "model performance" },
  { path: `/models/${ids.model}/explanations`, expect: /SHAP|feature|importance|Contract|Tenure/i, label: "model explanations" },
  { path: "/predictions", expect: /risk|probab|customer|prediction/i, label: "predictions list" },
  { path: `/predictions/${ids.prediction}`, expect: /risk|probab|customer|SHAP/i, label: "prediction detail" },
  { path: "/customers", expect: /customer|contract|tenure/i, label: "customers list" },
  { path: `/customers/${ids.customer}`, expect: /contract|tenure|churn|charge/i, label: "customer detail" },
  { path: "/training", expect: /run|model|status|completed/i, label: "training list" },
  { path: `/training/${ids.run}`, expect: /run|model|status|stage/i, label: "training detail" },
  { path: "/retention", expect: /action|retention|at risk/i, label: "retention overview" },
  { path: "/retention/strategies", expect: /strategy|contract|tenure/i, label: "strategies list" },
  // `/retention/[id]` is the action detail route, not a strategy one, and it
  // loads its data on the client, so the server response is a shell with the
  // banner and navigation already in it.
  {
    path: `/retention/${ids.action}`,
    expect: /Retention action|Loading/,
    label: "action detail",
  },
  { path: "/reports", expect: /report|model performance|summary/i, label: "reports list" },
  { path: "/audit", expect: /audit|action|actor/i, label: "audit trail" },
  { path: "/settings", expect: /threshold|risk|model/i, label: "settings" },
  { path: "/settings/model", expect: /model|endpoint|service/i, label: "settings: model" },
  { path: "/settings/profile", expect: /name|email|password/i, label: "settings: profile" },
  { path: "/settings/team", expect: /role|team|user|admin/i, label: "settings: team" },
];

/**
 * A 307 is a pass where a redirect is the designed outcome: the sign-in pages
 * send an authenticated visitor to the dashboard, and protected pages send an
 * anonymous one to sign-in.
 */
const publicPages = ["/login", "/forgot-password"];

let failures = 0;
const results: string[] = [];

async function check(
  target: string,
  expect: RegExp | null,
  label: string,
  options: {
    /** False for binary responses, which have no banner and no readable text. */
    html?: boolean;
    /** For a binary response, the content type it must have. */
    expectType?: string;
    allowRedirect?: boolean;
    /** True for endpoints that only answer one method, checked with the wrong one. */
    allowMethodMismatch?: boolean;
  } = {},
): Promise<void> {
  const html = options.html ?? true;
  let status = 0;
  let body = "";
  const problems: string[] = [];

  try {
    const response = await fetch(`${BASE}${target}`, {
      headers: { cookie },
      redirect: "manual",
    });
    status = response.status;
    const contentType = response.headers.get("content-type") ?? "";
    if (html) {
      body = await response.text();
    } else {
      const bytes = (await response.arrayBuffer()).byteLength;
      if (options.expectType && !contentType.includes(options.expectType)) {
        problems.push(`expected ${options.expectType}, got ${contentType || "nothing"}`);
      } else if (bytes < 64) {
        problems.push(`only ${bytes} bytes, so the response is probably empty`);
      }
      body = `${bytes} bytes of ${contentType}`;
    }
  } catch (caught) {
    problems.push(`threw: ${caught instanceof Error ? caught.message : String(caught)}`);
  }

  if (status >= 400 && !(status === 405 && options.allowMethodMismatch)) {
    problems.push(`status ${status}`);
  }
  if (expect && status === 200 && !expect.test(body)) {
    problems.push("no expected content found (page looks empty)");
  }
  // The important guard.
  //
  // A component that throws while the page is streaming does not change the
  // response status: the shell has already been sent as 200, and the visitor
  // gets the error boundary instead. A status check therefore passes a page the
  // user cannot use, which is exactly what happened with a server component
  // calling a function exported from a "use client" module. The boundary text
  // has to be looked for directly.
  if (
    status === 200 &&
    /This page could not be loaded|Something went wrong while fetching the data|Attempted to call .* from the server/.test(
      body,
    )
  ) {
    problems.push("the page rendered its error boundary instead of its content");
  }
  // Every rendered page carries the banner, so nobody mistakes a generated
  // figure for a measured one.
  if (html && status === 200 && !/Simulated mode/.test(body)) {
    problems.push("simulated-mode banner missing");
  }
  if (options.allowRedirect && status === 307) {
    // Designed behaviour; drop any complaint about having no content.
    problems.length = 0;
  }

  if (problems.length > 0) failures += 1;
  const size = status === 200 ? body.length.toLocaleString() : "-";
  results.push(
    `  ${problems.length === 0 ? "PASS" : "FAIL"}  ${label.padEnd(30)} ${String(status).padEnd(4)} ${size.padEnd(9)} ${problems.join("; ")}`,
  );
}

for (const page of publicPages) {
  await check(page, null, page, { allowRedirect: true });
}
for (const page of pages) {
  await check(page.path, page.expect, page.label);
}
for (const kind of ["roc_plot", "confusion_plot", "decile_plot", "importance_plot", "beeswarm_plot"]) {
  await check(`/api/models/${ids.model}/charts/${kind}`, null, `chart: ${kind}`, {
    html: false,
    expectType: "image/png",
  });
}
if (ids.report) {
  await check(`/api/reports/${ids.report}/download`, null, "report download", {
    html: false,
    expectType: "csv",
  });
}
if (ids.customer) {
  // A POST endpoint, so a GET being rejected is the correct answer.
  await check(
    `/api/customers/${ids.customer}/explanation`,
    null,
    "customer explanation (GET)",
    { allowMethodMismatch: true },
  );
}

process.stdout.write(`\n${results.join("\n")}\n`);
const total = pages.length + publicPages.length + 7;
process.stdout.write(`\n${total} checks, ${failures} failed\n`);
process.exitCode = failures === 0 ? 0 : 1;
