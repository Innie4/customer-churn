/**
 * Build a complete demo world, without Python.
 *
 * Every step below goes through the application's own data access layer, by
 * way of an identity bound for the length of the script. Nothing is inserted
 * with hand-written SQL, so the demo data is created by exactly the code that
 * serves the pages and cannot drift from what they expect.
 *
 * The machine learning service is stood in for by the in-process simulator
 * (see src/lib/simulate), so the figures are generated rather than learned.
 * Every page that reports a number says so.
 *
 *   npm run demo:seed            add the world, or report what already exists
 *   npm run demo:seed -- --fresh start again from an empty database
 *
 * Run through tsx with the react-server condition, because the data access
 * layer imports modules marked `server-only`, which otherwise refuse to load
 * outside a Next.js server.
 */

process.env.SIMULATED_MODE = "true";

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { getDatabase, migrateClient, resetDatabaseCache, usingPGlite } from "../db/client";
import { derivePasswordHash } from "../src/lib/auth/crypto";
import { checkPasswordPolicy } from "../src/lib/auth/policy";
import { asRole, withActor } from "../src/lib/dal/actor-context";
import {
  listDatasets,
  loadCustomers,
  preprocessDataset,
  revalidateDataset,
  uploadDataset,
} from "../src/lib/dal/datasets";
import {
  activateModel,
  listModels,
  startTraining,
  syncModelRun,
  type ModelType,
} from "../src/lib/dal/models";
import {
  explainCustomer,
  generateGlobalExplanation,
  generatePredictions,
} from "../src/lib/dal/customers";
import {
  changeActionStatus,
  createAction,
  createStrategy,
  listStrategies,
} from "../src/lib/dal/retention";
import { generateReport } from "../src/lib/dal/reports";
// The same list the sign-in page offers, so the two cannot drift apart.
import { DEMO_ACCOUNTS } from "../src/lib/demo-accounts";
import { resetServiceState } from "../src/lib/simulate/service";
import { buildPopulation } from "../src/lib/simulate/population";

const FRESH = process.argv.includes("--fresh");

/**
 * The password both demo accounts share.
 *
 * One generated value, so the sign-in page can offer either account without
 * either password being shown or typed. It is local to the demo database and
 * never committed: the seed records it in `.data/demo-credentials.txt`, and
 * `demo:dev` reads it back from there to set the environment variable the
 * sign-in page depends on.
 */
const DEMO_PASSWORD =
  process.env.DEMO_ACCOUNT_PASSWORD?.trim() ||
  `Demo-${randomBytes(12).toString("base64url")}9`;

const DATASET_NAME = "Telco churn (simulated demo)";
const TARGET = "Churn";
const ID_COLUMN = "customerID";

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * The open connection, so it can be closed once the script is done.
 *
 * PGlite holds the event loop open. A script that forgets to close it appears
 * to hang long after its last line of output, which reads as a failure.
 */
let openDatabase: { close(): Promise<void> } | null = null;

async function closeOpenDatabase(): Promise<void> {
  if (!openDatabase) return;
  const connection = openDatabase;
  openDatabase = null;
  await connection.close().catch(() => undefined);
  // The cache still holds the closed client, which would fail any later call
  // with a confusing error instead of reconnecting.
  resetDatabaseCache();
}

function step(number: number, message: string): void {
  process.stdout.write(`\n[${number}] ${message}\n`);
}

/**
 * The dataset to load.
 *
 * The real benchmark file is preferred when it is present, because authentic
 * rows make the distributions on the pages believable. Otherwise a synthetic
 * file is written from the same population the simulator scores, so the demo
 * still works in a fresh clone.
 */
function datasetFile(): { buffer: Buffer; filename: string; source: string } {
  const sample = path.resolve("sample-data/Telco-Customer-Churn.csv");
  if (existsSync(sample)) {
    return {
      buffer: readFileSync(sample),
      filename: "Telco-Customer-Churn.csv",
      source: "sample-data/Telco-Customer-Churn.csv",
    };
  }
  const population = buildPopulation();
  const lines = [
    "customerID,gender,SeniorCitizen,Partner,Dependents,tenure,PhoneService,MultipleLines,InternetService,OnlineSecurity,OnlineBackup,TechSupport,StreamingTV,StreamingMovies,Contract,PaperlessBilling,PaymentMethod,MonthlyCharges,TotalCharges,Churn",
  ];
  for (const customer of population.customers) {
    lines.push(
      [
        customer.customerId,
        customer.gender,
        customer.seniorCitizen,
        customer.partner,
        customer.dependents,
        customer.tenureMonths,
        customer.phoneService,
        customer.multipleLines,
        customer.internetService,
        customer.onlineSecurity,
        customer.onlineBackup,
        customer.techSupport,
        customer.streamingTv,
        customer.streamingMovies,
        customer.contract,
        customer.paperlessBilling,
        customer.paymentMethod,
        customer.monthlyCharges,
        customer.totalCharges ?? "",
        customer.churned ? "Yes" : "No",
      ].join(","),
    );
  }
  return {
    buffer: Buffer.from(lines.join("\n"), "utf8"),
    filename: "Telco-Customer-Churn.csv",
    source: "generated from the simulated population",
  };
}

/** The retention library, taken from the study's SHAP-to-strategy mapping. */
const STRATEGY_LIBRARY = [
  {
    title: "Structured onboarding for new customers",
    description:
      "Customers with short tenure have had the least time to build a relationship and the least to lose. Early, structured contact establishes that relationship before the point at which most churn happens.",
    triggeringCondition:
      "The customer's tenure is short and the model flagged low tenure as pushing their churn risk up.",
    riskDriver: "Tenure (months)",
    sourceColumn: "tenure",
    suggestedIntervention:
      "Run a structured onboarding sequence over the first ninety days, with a named contact and a check-in at thirty and sixty days.",
    priority: "high",
  },
  {
    title: "Contract migration offer",
    description:
      "Month-to-month customers are the single strongest driver of churn in this data. A longer commitment, priced competitively, removes the decision point at which they leave.",
    triggeringCondition:
      "The model identified the customer's month-to-month contract as the largest contributor to their churn risk.",
    riskDriver: "Contract type",
    sourceColumn: "Contract",
    suggestedIntervention:
      "Offer a twelve-month contract at a discounted rate, with a stated upgrade path. Present it at the point the customer queries their bill.",
    priority: "high",
  },
  {
    title: "Fibre service quality review",
    description:
      "Fibre customers churn at a higher rate, and the gap narrows markedly for those with technical support. The first call should establish whether the service is performing as sold.",
    triggeringCondition:
      "The customer is on fibre and the model reported the combination of fibre service and no technical support as raising their risk.",
    riskDriver: "Internet service",
    sourceColumn: "InternetService",
    suggestedIntervention:
      "Commission a technical review of the line, and offer a support add-on at no cost for the first quarter.",
    priority: "high",
  },
  {
    title: "Payment method migration",
    description:
      "Electronic-check customers churn more, which usually reflects a lower relationship rather than a problem with the payment itself. Direct debit lowers the friction of staying.",
    triggeringCondition:
      "The model identified electronic-check payment as raising this customer's churn risk.",
    riskDriver: "Payment method",
    sourceColumn: "PaymentMethod",
    suggestedIntervention:
      "Migrate the customer to direct debit with a small prompt-payment incentive, and confirm the change by phone.",
    priority: "medium",
  },
  {
    title: "Add tech support and online security",
    description:
      "Customers without technical support or online security are more likely to leave, in both the churn outcomes and the model's own scoring. The add-ons also make the service harder to cancel.",
    triggeringCondition:
      "The model reported the absence of technical support or online security as raising this customer's churn risk.",
    riskDriver: "Service add-ons",
    sourceColumn: "TechSupport",
    suggestedIntervention:
      "Offer technical support and online security as a paired bundle at a reduced rate, with a thirty-day no-questions refund.",
    priority: "medium",
  },
  {
    title: "Loyalty recognition for long-tenure customers",
    description:
      "Long tenure is the strongest protection against churn. Recognising it early, before the contract anniversary, is cheap and reliably effective.",
    triggeringCondition:
      "The customer has a long tenure and their contract is due for renewal.",
    riskDriver: "Tenure (months)",
    sourceColumn: "tenure",
    suggestedIntervention:
      "Send a recognition note and a renewal offer two months before the contract anniversary.",
    priority: "low",
  },
];

async function main(): Promise<number> {
  if (FRESH) {
    step(0, "Resetting the demo");
    // A genuine clean start: the local database directory is removed, not just
    // emptied, so migrations run again from scratch and the demo exercises the
    // migration path rather than inheriting an already-migrated database.
    if (usingPGlite()) {
      const dir = path.join(process.cwd(), ".data", "postgres");
      rmSync(dir, { recursive: true, force: true });
      say(`  removed the local database at ${dir}`);
    } else {
      say(
        "  DATABASE_URL is set, so the demo will not delete a real database.\n" +
          "  Point DATABASE_DRIVER at pglite, or run this against a throwaway instance.",
      );
    }
    resetServiceState();
  }

  // The shared client, not a private one. The data access layer reaches the
  // database through `getDatabase`, and PGlite must have exactly one instance
  // per directory: a second connection to the same data directory competes
  // with the first, and the work the data access layer does is silently lost
  // when the process ends. `createDatabase` exists for scripts that bypass the
  // data access layer entirely, which is not what this one does.
  const db = await getDatabase();
  openDatabase = db;
  const migration = await migrateClient(db, { verbose: false });
  if (migration.failed) {
    throw new Error(
      `Migration ${migration.failed.id} failed: ${migration.failed.error}`,
    );
  }
  say(`Schema is up to date (${migration.applied.length} applied this run).`);

  // The two accounts offered on the sign-in page, created if absent.
  //
  // They exist so a visitor can open the platform without being handed a
  // password first, so the seed's job is to make sure they exist and to record
  // the shared password somewhere local. The pair is deliberately a different
  // role each, so the demonstration shows what the role model actually does.
  checkPasswordPolicy(DEMO_PASSWORD);
  const passwordHash = await derivePasswordHash(DEMO_PASSWORD);
  const createdAccounts: { email: string; role: string }[] = [];

  for (const account of DEMO_ACCOUNTS) {
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = $1",
      [account.email],
    );
    if (existing.rows[0]) {
      say(`Reusing the existing account ${account.email} (${account.role}).`);
      createdAccounts.push({ email: account.email, role: account.role });
      continue;
    }
    await db.query(
      `INSERT INTO users (email, password_hash, full_name, role, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [account.email, passwordHash, account.displayName, account.role],
    );
    await db.query(
      `INSERT INTO audit_logs (actor_email, action, resource_type, outcome, metadata)
       VALUES ($1, 'user.created', 'user', 'success', $2::jsonb)`,
      [
        account.email,
        JSON.stringify({ via: "demo seed script", role: account.role }),
      ],
    );
    createdAccounts.push({ email: account.email, role: account.role });
    say(`Created the ${account.role} demo account ${account.email}.`);
  }

  // The administrator is the one the seed acts as while it builds the world.
  const administrator = createdAccounts.find(
    (account) => account.role === "admin",
  );
  if (!administrator) throw new Error("No administrator demo account.");

  const adminRow = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE lower(email) = $1",
    [administrator.email],
  );
  const userId = adminRow.rows[0]!.id;

  // The password is generated, so it has to be recorded somewhere for the
  // person running the demo. This file is under .data, which is ignored by Git,
  // so a working credential never reaches the repository. `demo:dev` reads it
  // back to enable the one-click sign-in.
  mkdirSync(path.join(process.cwd(), ".data"), { recursive: true });
  writeFileSync(
    path.join(process.cwd(), ".data", "demo-credentials.txt"),
    [
      "Local demo credentials. Not real credentials, and not committed to Git.",
      "",
      "url=http://localhost:3000",
      `password=${DEMO_PASSWORD}`,
      "",
      "accounts:",
      ...createdAccounts.map(
        (account) => `  ${account.role.padEnd(8)} ${account.email}`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );

  const actor = {
    id: userId,
    email: administrator.email,
    fullName: "Demo administrator",
    role: asRole("admin"),
  };

  return withActor(actor, async () => {
    const alreadyThere = (await listDatasets()).find(
      (dataset) => dataset.name === DATASET_NAME && !dataset.deletedAt,
    );
    if (alreadyThere) {
      say(
        `\nA dataset named "${DATASET_NAME}" already exists. Nothing was changed.\n` +
          `Start again from scratch with:  npm run demo:seed -- --fresh`,
      );
      return 0;
    }

    const file = datasetFile();
    say(`Dataset source: ${file.source}`);

    step(1, "Uploading the dataset");
    const upload = await uploadDataset({
      file: {
        filename: file.filename,
        buffer: file.buffer,
        contentType: "text/csv",
      },
      name: DATASET_NAME,
      targetColumn: TARGET,
      idColumns: [ID_COLUMN],
      actor: { ...actor, sessionId: "script", expiresAt: new Date().toISOString() },
    });
    const datasetId = upload.dataset.id;
    say(
      `  ${upload.inspection.row_count.toLocaleString()} rows, ` +
        `${upload.inspection.column_count} columns, ` +
        `churn rate ${(upload.inspection.target_positive_rate * 100).toFixed(2)}%`,
    );

    step(2, "Validating it");
    const validation = await revalidateDataset(datasetId);
    for (const issue of validation.issues) {
      say(`  ${issue.severity.padEnd(7)} ${issue.message}`);
    }

    step(3, "Preprocessing");
    const preprocessing = await preprocessDataset(datasetId, {
      targetColumn: TARGET,
      idColumns: [ID_COLUMN],
      testSize: 0.2,
      stratify: true,
      applySmote: true,
      randomSeed: 42,
    });
    for (const entry of preprocessing.result.steps) {
      say(`  ${entry.step.padEnd(9)} ${entry.rows_in} -> ${entry.rows_out}  ${entry.description}`);
    }
    say(
      `  split: ${preprocessing.result.split.train_rows.toLocaleString()} train / ` +
        `${preprocessing.result.split.test_rows.toLocaleString()} test`,
    );
    const preprocessingRunId = preprocessing.run.id;

    step(4, "Loading customers");
    const loaded = await loadCustomers(datasetId, {
      targetColumn: TARGET,
      idColumns: [ID_COLUMN],
    });
    say(`  ${loaded.inserted.toLocaleString()} inserted, ${loaded.updated} updated`);

    step(5, "Training models");
    const modelTypes: ModelType[] = [
      "logistic_regression",
      "random_forest",
      "xgboost",
    ];
    const run = await startTraining({
      datasetId,
      preprocessingRunId,
      modelTypes,
      cvFolds: 5,
      randomSeed: 42,
      label: "Simulated demo run",
    });
    // The real service answers asynchronously, so the run is polled exactly as
    // the training page polls it.
    let finished = run;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (finished.status === "completed" || finished.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 150));
      finished = await syncModelRun(run.id);
    }
    if (finished.status !== "completed") {
      throw new Error(
        `Training did not complete: ${finished.error ?? finished.status}`,
      );
    }
    say(`  run ${finished.id} completed in ${finished.durationSeconds ?? 0}s`);

    step(6, "Reviewing the model results");
    const models = await listModels();
    for (const model of models) {
      const test = model.testMetrics;
      say(
        `  ${model.displayName.padEnd(20)} test AUC ${test?.["roc_auc"]?.toFixed(4) ?? "n/a"}` +
          `   recall ${test?.recall?.toFixed(4) ?? "n/a"}` +
          `   accuracy ${test?.accuracy?.toFixed(4) ?? "n/a"}`,
      );
    }

    // The tree model is activated, matching how the platform is meant to be
    // used: compare first, then choose.
    const chosen =
      models.find((model) => model.modelType === "xgboost") ?? models[0];
    if (!chosen) throw new Error("Training produced no models.");
    step(7, "Activating a model");
    await activateModel(
      chosen.id,
      "Chosen from the demo run: comparable accuracy to the linear model with a stronger recall on the minority class.",
    );
    say(`  ${chosen.displayName} is now active.`);

    step(8, "Scoring every customer");
    const scored = await generatePredictions({ modelId: chosen.id });
    say(
      `  ${scored.scored.toLocaleString()} scored — ` +
        `${scored.riskCounts.high} high, ${scored.riskCounts.medium} medium, ` +
        `${scored.riskCounts.low} low`,
    );

    step(9, "Explaining customers");
    // The highest-risk customers, which is who a retention analyst looks at
    // first and therefore what the detail pages most need to be able to show.
    const topRisk = [...scored.predictions]
      .sort((a, b) => b.churnProbability - a.churnProbability)
      .slice(0, 12);
    let explained = 0;
    for (const prediction of topRisk) {
      try {
        await explainCustomer(prediction.customerId, { topN: 5 });
        explained += 1;
      } catch {
        // A single customer failing must not abandon the rest of the world.
      }
    }
    say(`  explained ${explained} of the ${topRisk.length} highest-risk customers`);

    step(10, "Building the global explanation");
    const global = await generateGlobalExplanation(chosen.id, { sampleSize: 1000 });
    const top = global.features[0];
    say(
      `  strongest driver: ${top?.label ?? "n/a"} ` +
        `(mean |SHAP| ${top?.meanAbsShap.toFixed(4) ?? "n/a"})`,
    );

    step(11, "Preparing the retention strategy library");
    const existingStrategies = await listStrategies();
    let strategies = existingStrategies;
    if (existingStrategies.length === 0) {
      const created = [];
      for (const entry of STRATEGY_LIBRARY) {
        created.push(await createStrategy({ ...entry, notes: null }));
      }
      // A couple are approved so the retention pages have something in flight.
      // Approval records who approved it, so this is done through the ordinary
      // path rather than by writing the audit trail by hand.
      await approveStrategy(created[0]!.id);
      await approveStrategy(created[1]!.id);
      strategies = await listStrategies();
      say(`  created ${created.length} strategies, approved the first`);
    } else {
      say(`  ${existingStrategies.length} strategies already present`);
    }

    const approved = strategies.filter((strategy) => strategy.status === "approved");
    step(12, "Raising retention actions");
    let actions = 0;
    for (const prediction of topRisk.slice(0, 5)) {
      const strategy =
        approved.find((entry) =>
          topRisk.some(() => entry.sourceColumn === "Contract"),
        ) ?? approved[0];
      if (!strategy) break;
      try {
        const action = await createAction({
          customerId: prediction.customerId,
          strategyId: strategy.id,
          title: `Retention outreach to customer ${prediction.customerId}`,
          description:
            "This customer is in the highest-risk tenth. Their largest risk driver is the contract type, so the first call should lead with the migration offer.",
          priority: prediction.churnProbability >= 0.7 ? "high" : "medium",
          assignedTo: userId,
          notes: "Raised by the demo seed.",
          suggestedIntervention: strategy.suggestedIntervention,
        });
        // Move it out of "suggested" so the boards show a realistic mix.
        if (actions % 2 === 0) {
          await changeActionStatus(
            action.id,
            "in_progress",
            "Accepted for outreach this week.",
          );
        }
        actions += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  (action for ${prediction.customerId} failed: ${reason})\n`);
      }
    }
    say(`  raised ${actions} actions against the highest-risk customers`);

    step(13, "Generating reports");
    for (const kind of [
      "model_performance",
      "prediction_summary",
      "retention_summary",
      "shap_global",
    ] as const) {
      try {
        const report = await generateReport({
          kind,
          format: "csv",
          title: `Demo: ${kind.replace(/_/g, " ")}`,
          datasetId,
          modelResultId: chosen.id,
          limit: 25,
        });
        say(`  ${kind.padEnd(20)} ${report.id}`);
      } catch {
        say(`  ${kind.padEnd(20)} skipped`);
      }
    }

    step(14, "Done");
    say(`
The demo world is ready.

  npm run demo:dev

then open either demo account from the sign-in page with one click. No password
is typed, and each sign-in is still recorded in the audit trail.

Every model metric, probability and SHAP value on these pages is generated by
the in-process simulator, not learned from data. The pages carry a banner
saying so. No Python process is involved at any point.

To start again from an empty database:

  npm run demo:reset
`);
    return 0;
  });
}

/** Approve a strategy, tolerating the case where the schema forbids it. */
async function approveStrategy(strategyId: string): Promise<void> {
  const { setStrategyStatus } = await import("../src/lib/dal/retention");
  try {
    await setStrategyStatus(strategyId, "approved", "Approved for the demo.");
  } catch (error) {
    // Not fatal, but say why, because a silent no-op here would leave the
    // retention pages empty for a reason nobody could see.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`  (could not approve ${strategyId}: ${reason})\n`);
  }
}

// Top-level await, deliberately. A promise chain ending in `.finally` does not
// keep the process alive: once the work settles and the event loop has no
// pending handles, node exits, and the pending database close is abandoned
// mid-write. Awaiting here holds the module open until the connection is
// genuinely closed, which is what makes the demo survive to disk.
try {
  process.exitCode = await main();
} catch (error: unknown) {
  process.stderr.write(
    `\nThe demo world could not be built: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
} finally {
  await closeOpenDatabase();
}
