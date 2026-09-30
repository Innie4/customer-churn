/**
 * Turns an uploaded CSV into a population the risk model can score.
 *
 * Reuses the application's own CSV parser rather than a second one, so the
 * simulated frontend accepts exactly the files the real service accepts:
 * the same delimiter sniffing, the same quoting rules, the same id handling.
 *
 * Column names are matched leniently, because a customer's file will not
 * necessarily spell things the way the benchmark does.
 */

import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/dal/datasets";
import { Customer, ContractType, InternetService, PaymentMethod, YesNo } from "./population";
import { Rng, logit, sigmoid, solveIntercept } from "./rng";

type Attributes = Record<string, unknown>;

/** Case- and separator-insensitive column lookup. */
function lookup(attributes: Attributes, ...names: string[]): string | undefined {
  const index = new Map<string, string>();
  for (const [key, value] of Object.entries(attributes)) {
    index.set(key.toLowerCase().replace(/[^a-z0-9]/g, ""), String(value ?? "").trim());
  }
  for (const name of names) {
    const hit = index.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function toYesNo(raw: string | undefined, fallback: YesNo): YesNo {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(value)) return "Yes";
  if (["no", "n", "false", "0"].includes(value)) return "No";
  return fallback;
}

function toContract(raw: string | undefined): ContractType {
  const value = (raw ?? "").toLowerCase();
  if (value.includes("two") || value === "2") return "Two year";
  if (value.includes("one") || value === "1") return "One year";
  return "Month-to-month";
}

function toInternetService(raw: string | undefined): InternetService {
  const value = (raw ?? "").toLowerCase();
  if (value.includes("fiber") || value.includes("fibre")) return "Fiber optic";
  if (value === "no" || value === "none" || value === "") return "No";
  return "DSL";
}

function toPaymentMethod(raw: string | undefined): PaymentMethod {
  const value = (raw ?? "").toLowerCase();
  if (value.includes("electronic")) return "Electronic check";
  if (value.includes("credit")) return "Credit card";
  if (value.includes("bank") || value.includes("transfer")) return "Bank transfer";
  return "Mailed check";
}

function tenureBandFor(tenure: number): string {
  if (tenure <= 6) return "0-6 months";
  if (tenure <= 12) return "7-12 months";
  if (tenure <= 24) return "13-24 months";
  if (tenure <= 48) return "25-48 months";
  return "49+ months";
}

/**
 * The linear risk terms, recomputed from the row's own values.
 *
 * The weights are the same constants the synthetic population uses, so an
 * uploaded file and the built-in demo world are scored by the same model.
 * No intercept is included here: the caller adds one, chosen so that the
 * average predicted probability matches the file's own churn rate.
 */
function riskTerms(row: {
  contract: ContractType;
  internetService: InternetService;
  onlineSecurity: YesNo;
  techSupport: YesNo;
  paymentMethod: PaymentMethod;
  paperlessBilling: YesNo;
  multipleLines: YesNo;
  dependents: YesNo;
  seniorCitizen: 0 | 1;
  tenure: number;
  monthlyCharges: number;
}): number {
  let score = 0;
  score +=
    row.contract === "Month-to-month" ? 1.62
    : row.contract === "One year" ? -0.44
    : -1.21;
  score +=
    row.internetService === "Fiber optic" ? 0.88
    : row.internetService === "No" ? -0.51
    : 0;
  if (row.internetService !== "No") {
    if (row.onlineSecurity === "No") score += 0.62;
    if (row.techSupport === "No") score += 0.49;
  }
  score +=
    row.paymentMethod === "Electronic check" ? 0.74
    : row.paymentMethod === "Bank transfer" ? -0.22
    : 0;
  if (row.paperlessBilling === "Yes") score += 0.31;
  if (row.multipleLines === "Yes") score += 0.19;
  if (row.dependents === "Yes") score -= 0.27;
  if (row.seniorCitizen === 1) score += 0.24;
  score += row.tenure <= 12 ? 0.58 : row.tenure <= 48 ? 0.12 : -0.94;
  if (row.monthlyCharges >= 80) score += 0.34;
  return score;
}

export interface CsvWorld {
  customers: Customer[];
  /** The target column as it appeared in the file. */
  targetColumn: string;
  idColumn: string | null;
  /** True when the file carried a usable target, so scores can be scored. */
  hasLabels: boolean;
  /** Rows whose target was present and recognised. */
  labelledRows: number;
  blankTargetRows: number;
  observedChurnRate: number | null;
}

/**
 * Map parsed rows onto the risk model's attribute shape.
 *
 * Calibration happens in two passes. The first reads each row's attributes and
 * records its weighted risk term. The second solves for the single intercept
 * that makes the average predicted probability equal the churn rate actually
 * observed in the file, then applies it.
 *
 * Without that step the weights alone would decide the base rate, and since
 * most customers are on a month-to-month contract the intercept would push most
 * probabilities above one half. The model would then call nearly everyone a
 * churner, and the pages would show a high recall at a useless accuracy.
 */
export function buildCustomersFromRows(
  rows: { externalId: string; observedChurn: number | null; attributes: Attributes }[],
  seed: string,
): { customers: Customer[]; labelled: number; intercept: number } {
  const shapedRows = rows.map((row) => {
    const attributes = row.attributes;
    const tenure = toNumber(lookup(attributes, "tenure", "months", "tenuremonths")) ?? 0;
    const monthlyCharges =
      toNumber(lookup(attributes, "monthlycharges", "monthly", "charge")) ?? 50;
    const totalCharges = toNumber(lookup(attributes, "totalcharges", "total"));

    const phoneService = toYesNo(lookup(attributes, "phoneservice", "phone"), "Yes");
    const internetService = toInternetService(lookup(attributes, "internetservice", "internet"));
    const hasInternet = internetService !== "No";

    const shaped: {
      contract: ContractType;
      internetService: InternetService;
      onlineSecurity: YesNo;
      techSupport: YesNo;
      paymentMethod: PaymentMethod;
      paperlessBilling: YesNo;
      multipleLines: YesNo;
      dependents: YesNo;
      seniorCitizen: 0 | 1;
      tenure: number;
      monthlyCharges: number;
    } = {
      contract: toContract(lookup(attributes, "contract", "contracttype")),
      internetService,
      onlineSecurity: toYesNo(lookup(attributes, "onlinesecurity", "security"), hasInternet ? "Yes" : "No"),
      techSupport: toYesNo(lookup(attributes, "techsupport", "support"), hasInternet ? "Yes" : "No"),
      paymentMethod: toPaymentMethod(lookup(attributes, "paymentmethod", "payment")),
      paperlessBilling: toYesNo(lookup(attributes, "paperlessbilling", "paperless"), "Yes"),
      multipleLines: toYesNo(lookup(attributes, "multiplelines", "lines"), phoneService === "Yes" ? "No" : "No"),
      dependents: toYesNo(lookup(attributes, "dependents", "dependent"), "No"),
      seniorCitizen: toYesNo(lookup(attributes, "seniorcitizen", "senior"), "No") === "Yes" ? 1 : 0,
      tenure,
      monthlyCharges,
    };

    return { row, shaped, totalCharges, phoneService, internetService, hasInternet };
  });

  // The rate the file itself shows, which is what the model must reproduce.
  const labelled = shapedRows.filter((entry) => entry.row.observedChurn !== null);
  const churners = labelled.filter((entry) => entry.row.observedChurn === 1).length;
  const observedRate =
    labelled.length > 0
      ? churners / labelled.length
      : // No usable target: fall back to a rate typical of the domain rather
        // than to something arbitrary.
        0.265;
  const terms = shapedRows.map((entry) => riskTerms(entry.shaped));
  const intercept = solveIntercept(terms, observedRate);

  const customers: Customer[] = shapedRows.map((entry, index) => {
    const { row, shaped, totalCharges, phoneService, internetService, hasInternet } = entry;
    const baseProbability = sigmoid(intercept + terms[index]!);
    // A row with a real label uses it. A row without one gets a plausible
    // outcome, so an unlabelled file still produces a sensible ranking.
    const rng = new Rng(`${seed}:${row.externalId}:${index}`);
    const churned: 0 | 1 =
      row.observedChurn !== null
        ? (row.observedChurn as 0 | 1)
        : rng.chance(baseProbability)
          ? 1
          : 0;

    return {
      index,
      customerId: row.externalId,
      gender: (lookup(row.attributes, "gender") === "Female" ? "Female" : "Male") as "Male" | "Female",
      seniorCitizen: shaped.seniorCitizen,
      partner: toYesNo(lookup(row.attributes, "partner"), "No"),
      dependents: shaped.dependents,
      tenureMonths: shaped.tenure,
      phoneService,
      multipleLines: shaped.multipleLines,
      internetService,
      onlineSecurity: shaped.onlineSecurity,
      onlineBackup: toYesNo(lookup(row.attributes, "onlinebackup", "backup"), hasInternet ? "No" : "No"),
      techSupport: shaped.techSupport,
      streamingTv: toYesNo(lookup(row.attributes, "streamingtv", "tv"), hasInternet ? "No" : "No"),
      streamingMovies: toYesNo(lookup(row.attributes, "streamingmovies", "movies"), hasInternet ? "No" : "No"),
      contract: shaped.contract,
      paperlessBilling: shaped.paperlessBilling,
      paymentMethod: shaped.paymentMethod,
      monthlyCharges: shaped.monthlyCharges,
      totalCharges,
      tenureBand: tenureBandFor(shaped.tenure),
      churned,
      baseProbability,
    };
  });

  return { customers, labelled: labelled.length, intercept };
}

const cache = new Map<string, CsvWorld>();

/**
 * Parse a CSV into a scored world, memoised on the file's contents.
 *
 * Every page that shows a customer list re-reads the same dataset, and parsing
 * seven thousand rows each time would make the demo feel broken. The key
 * includes the parsing options, so a different target column cannot collide.
 */
export function worldForCsv(
  buffer: Buffer,
  targetColumn: string,
  idColumns: string[],
  seed = "demo",
): CsvWorld {
  const key = createHash("sha256")
    .update(buffer)
    .update(`|${targetColumn}|${idColumns.join(",")}|${seed}`)
    .digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;

  const parsed = parseCsv(buffer, targetColumn, idColumns);
  const { customers, labelled } = buildCustomersFromRows(parsed, seed);
  const blanks = parsed.length - labelled;
  const churners = customers.filter((customer) => customer.churned === 1).length;

  const world: CsvWorld = {
    customers,
    targetColumn,
    idColumn: idColumns[0] ?? null,
    hasLabels: labelled > 0,
    labelledRows: labelled,
    blankTargetRows: blanks,
    observedChurnRate: labelled > 0 ? round6(labelled ? churners / Math.max(labelled, 1) : 0) : null,
  };
  cache.set(key, world);
  return world;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The log-odds base value for a set of customers, used as the SHAP base. */
export function meanLogit(customers: Customer[]): number {
  if (customers.length === 0) return logit(0.265);
  return customers.reduce((sum, customer) => sum + logit(customer.baseProbability), 0) / customers.length;
}
