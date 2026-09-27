/**
 * Datasets: upload, inspection, validation, preprocessing and customer loading.
 *
 * The upload path validates the file before anything is stored, stores it under
 * a generated name, and records its digest. The digest is what makes a model
 * traceable to an exact file version later.
 */

import "server-only";

import { getDatabase, DatabaseError } from "../../../db/client";
import { AppError } from "../api";
import { AUDIT, recordAudit } from "../audit";
import { env } from "../env";
import { ml, type MlInspection, type MlPreprocessResult } from "../ml-client";
import { CONTENT_TYPES, extensionFor, generatedName, sha256, storage } from "../storage";
import { requireActor, type Actor } from "./access";

export type DatasetStatus =
  | "uploaded"
  | "inspecting"
  | "validated"
  | "invalid"
  | "preprocessing"
  | "preprocessed"
  | "training"
  | "ready"
  | "failed";

export interface DatasetSummary {
  id: string;
  name: string;
  originalFilename: string;
  status: DatasetStatus;
  sizeBytes: number;
  rowCount: number | null;
  columnCount: number | null;
  targetColumn: string | null;
  /**
   * Columns identifying a customer, decided at upload.
   *
   * Empty means the file carries no identifier, and customers are keyed by row
   * order. That is a real degradation, so it is surfaced rather than assumed.
   */
  idColumns: string[];
  targetPositiveRate: number | null;
  duplicateRowCount: number | null;
  uploadedByName: string | null;
  createdAt: string;
  updatedAt: string;
  validationStatus: string | null;
  errorCount: number | null;
  warningCount: number | null;
  deletedAt: string | null;
}

export interface DatasetDetail extends DatasetSummary {
  storagePath: string;
  sha256: string;
  columns: DatasetColumn[];
  targetDistribution: Record<string, number> | null;
  preprocessingRuns: PreprocessingRunSummary[];
}

export interface DatasetColumn {
  id: string;
  position: number;
  name: string;
  inferredType: string;
  pandasDtype: string;
  nonNullCount: number;
  nullCount: number;
  nullFraction: number;
  distinctCount: number;
  sampleValues: unknown[];
  minValue: number | null;
  maxValue: number | null;
  meanValue: number | null;
  isTarget: boolean;
}

export interface PreprocessingRunSummary {
  id: string;
  mlPreprocessingId: string;
  status: string;
  encodedFeatureCount: number | null;
  createdAt: string;
  completedAt: string | null;
  warnings: string[];
  error: string | null;
}

interface DatasetRow {
  id: string;
  name: string;
  original_filename: string;
  storage_path: string;
  size_bytes: string;
  sha256: string;
  status: DatasetStatus;
  target_column: string | null;
  id_columns: string[];
  row_count: number | null;
  column_count: number | null;
  target_distribution: Record<string, number> | null;
  target_positive_rate: string | null;
  duplicate_row_count: number | null;
  uploaded_by: string | null;
  uploader_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  validation_status: string | null;
  error_count: number | null;
  warning_count: number | null;
}

const DATASET_SELECT = `
  SELECT d.*, u.full_name AS uploader_name,
         v.status AS validation_status, v.error_count, v.warning_count
    FROM datasets d
    LEFT JOIN users u ON u.id = d.uploaded_by
    LEFT JOIN dataset_validation_results v ON v.id = d.latest_validation_id
`;

function toSummary(row: DatasetRow): DatasetSummary {
  return {
    id: row.id,
    name: row.name,
    originalFilename: row.original_filename,
    status: row.status,
    sizeBytes: Number(row.size_bytes),
    rowCount: row.row_count,
    columnCount: row.column_count,
    targetColumn: row.target_column,
    idColumns: Array.isArray(row.id_columns) ? (row.id_columns as string[]) : [],
    targetPositiveRate: row.target_positive_rate
      ? Number(row.target_positive_rate)
      : null,
    duplicateRowCount: row.duplicate_row_count,
    uploadedByName: row.uploader_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validationStatus: row.validation_status,
    errorCount: row.error_count,
    warningCount: row.warning_count,
    deletedAt: row.deleted_at,
  };
}

const ALLOWED_EXTENSIONS = new Set([".csv", ".tsv", ".txt"]);

export interface UploadResult {
  dataset: DatasetSummary;
  inspection: MlInspection;
  validationStored: boolean;
}

export interface UploadInput {
  file: { filename: string; buffer: Buffer; contentType: string };
  name?: string;
  targetColumn?: string;
  idColumns?: string[];
  actor: Actor;
}

/**
 * Validate and store an uploaded dataset, then inspect it.
 *
 * The file is checked before it is written, so an oversized or wrong-typed
 * upload never reaches disk.
 */
export async function uploadDataset(input: UploadInput): Promise<UploadResult> {
  const { file, actor } = input;
  const idColumns = input.idColumns ?? [];

  if (file.buffer.byteLength === 0) {
    throw AppError.badRequest("The uploaded file is empty.", {
      code: "empty_file",
      fields: { file: "Choose a file that contains data." },
      nextAction: "Pick a CSV file with at least one row.",
    });
  }
  if (file.buffer.byteLength > env.maxUploadBytes) {
    throw AppError.tooLarge(
      `That file is ${formatBytes(file.buffer.byteLength)}. The limit is ${formatBytes(
        env.maxUploadBytes,
      )}.`,
    );
  }

  const extension = extensionFor(file.filename);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw AppError.unprocessable(
      `Files of type ${extension || "unknown"} are not accepted.`,
      {
        code: "unsupported_file_type",
        fields: { file: "Upload a .csv, .tsv or .txt file." },
        nextAction: "Export the dataset as CSV and upload it again.",
      },
    );
  }

  // Only a text signature is accepted. This is not a full malware scan, and the
  // stored file is never executed, but it stops an obvious binary upload.
  if (looksBinary(file.buffer)) {
    throw AppError.unprocessable("That file is not a text table.", {
      code: "binary_content",
      fields: { file: "Upload a CSV file, not a binary one." },
      nextAction: "Export the dataset as UTF-8 CSV and upload it again.",
    });
  }

  const digest = sha256(file.buffer);
  const db = await getDatabase();

  const duplicate = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM datasets WHERE sha256 = $1 AND deleted_at IS NULL",
    [digest],
  );
  if (duplicate.rows[0]) {
    throw AppError.conflict(
      `This exact file has already been uploaded as "${duplicate.rows[0].name}".`,
      "Open the existing dataset, or upload a different file.",
    );
  }

  const stored = await storage().put(
    "datasets",
    generatedName("dataset", extension === ".tsv" ? ".tsv" : ".csv"),
    file.buffer,
    CONTENT_TYPES.csv,
  );

  const name = (input.name ?? file.filename.replace(/\.[^.]+$/, "")).trim();
  if (name.length < 1 || name.length > 200) {
    await storage().remove(stored.relativePath);
    throw AppError.unprocessable("Give the dataset a name of 1 to 200 characters.", {
      fields: { name: "Give the dataset a name of 1 to 200 characters." },
    });
  }

  let datasetId: string;
  try {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO datasets
         (name, original_filename, storage_path, size_bytes, sha256,
          mime_type, status, id_columns, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', $7::jsonb, $8)
       RETURNING id`,
      [
        name,
        file.filename.slice(0, 255),
        stored.relativePath,
        stored.sizeBytes,
        digest,
        CONTENT_TYPES.csv,
        // Recorded now rather than being asked for again later. The choice of
        // identifier decides how customers are keyed and how predictions are
        // matched back, so losing it silently degrades the whole chain to row
        // order.
        JSON.stringify(idColumns ?? []),
        actor.id,
      ],
    );
    datasetId = inserted.rows[0].id;
  } catch (error) {
    // Never leave an orphaned file behind if the row could not be written.
    await storage().remove(stored.relativePath);
    if (error instanceof DatabaseError && error.code === "23505") {
      throw AppError.conflict(
        "That file has already been uploaded.",
        "Open the existing dataset instead.",
      );
    }
    throw error;
  }

  await recordAudit({
    action: AUDIT.datasetUploaded,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "dataset",
    resourceId: datasetId,
    metadata: {
      name,
      filename: file.filename,
      sizeBytes: stored.sizeBytes,
      sha256: digest,
    },
  });

  // Inspect immediately, so the dataset is never listed with unknown structure.
  const inspection = await ml.inspect(
    { buffer: file.buffer, filename: file.filename, contentType: CONTENT_TYPES.csv },
    {
      targetColumn: input.targetColumn,
      idColumns: input.idColumns,
      previewRows: 25,
    },
  );

  const validationStored = await storeInspection(datasetId, inspection);

  return {
    dataset: (await getDataset(datasetId)) as DatasetSummary,
    inspection,
    validationStored,
  };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) {
    // Anything other than tab, newline, carriage return or a printable range
    // counts towards the control-character budget.
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

/** Persist an inspection as the dataset's structure and current verdict. */
async function storeInspection(
  datasetId: string,
  inspection: MlInspection,
): Promise<boolean> {
  const db = await getDatabase();
  const errors = inspection.issues.filter((i) => i.severity === "error").length;
  const warnings = inspection.issues.filter((i) => i.severity === "warning").length;
  const infos = inspection.issues.filter((i) => i.severity === "info").length;
  const status = errors > 0 ? "invalid" : "validated";

  return db.transaction(async (tx) => {
    await tx.query("DELETE FROM dataset_columns WHERE dataset_id = $1", [datasetId]);
    for (const column of inspection.columns) {
      await tx.query(
        `INSERT INTO dataset_columns
           (dataset_id, position, name, inferred_type, pandas_dtype,
            non_null_count, null_count, null_fraction, distinct_count,
            sample_values, min_value, max_value, mean_value, is_target)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,
        [
          datasetId,
          column.position,
          column.name,
          column.inferred_type,
          column.pandas_dtype,
          column.non_null_count,
          column.null_count,
          column.null_fraction,
          column.distinct_count,
          JSON.stringify(column.sample_values ?? []),
          column.min_value,
          column.max_value,
          column.mean_value,
          column.is_target,
        ],
      );
    }

    const validation = await tx.query<{ id: string }>(
      `INSERT INTO dataset_validation_results
         (dataset_id, status, error_count, warning_count, info_count, issues,
          row_count, column_count, parser_used)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (dataset_id) DO UPDATE
         SET status = EXCLUDED.status,
             error_count = EXCLUDED.error_count,
             warning_count = EXCLUDED.warning_count,
             info_count = EXCLUDED.info_count,
             issues = EXCLUDED.issues,
             row_count = EXCLUDED.row_count,
             column_count = EXCLUDED.column_count,
             created_at = now()
       RETURNING id`,
      [
        datasetId,
        errors > 0 ? "fail" : "pass",
        errors,
        warnings,
        infos,
        JSON.stringify(inspection.issues),
        inspection.row_count,
        inspection.column_count,
        "pandas.read_csv",
      ],
    );

    await tx.query(
      `UPDATE datasets
          SET status = $2, target_column = $3, row_count = $4, column_count = $5,
              target_distribution = $6::jsonb, target_positive_rate = $7,
              duplicate_row_count = $8, latest_validation_id = $9
        WHERE id = $1`,
      [
        datasetId,
        status,
        inspection.target_column || null,
        inspection.row_count,
        inspection.column_count,
        JSON.stringify(inspection.target_distribution ?? {}),
        inspection.target_positive_rate,
        inspection.duplicate_row_count,
        validation.rows[0].id,
      ],
    );
    return true;
  });
}

export async function listDatasets(
  options: { includeDeleted?: boolean } = {},
): Promise<DatasetSummary[]> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<DatasetRow>(
    `${DATASET_SELECT}
      ${options.includeDeleted ? "" : "WHERE d.deleted_at IS NULL"}
      ORDER BY d.created_at DESC`,
  );
  return result.rows.map(toSummary);
}

export async function getDataset(datasetId: string): Promise<DatasetDetail | null> {
  await requireActor();
  if (!isUuid(datasetId)) return null;
  const db = await getDatabase();
  const result = await db.query<DatasetRow>(
    `${DATASET_SELECT} WHERE d.id = $1`,
    [datasetId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const columns = await db.query<{
    id: string;
    position: number;
    name: string;
    inferred_type: string;
    pandas_dtype: string;
    non_null_count: number;
    null_count: number;
    null_fraction: string;
    distinct_count: number;
    sample_values: unknown[];
    min_value: number | null;
    max_value: number | null;
    mean_value: number | null;
    is_target: boolean;
  }>(
    "SELECT * FROM dataset_columns WHERE dataset_id = $1 ORDER BY position",
    [datasetId],
  );

  const runs = await db.query<{
    id: string;
    ml_preprocessing_id: string;
    status: string;
    encoded_feature_count: number | null;
    created_at: string;
    completed_at: string | null;
    warnings: unknown;
    error: string | null;
  }>(
    `SELECT id, ml_preprocessing_id, status, encoded_feature_count, created_at,
            completed_at, warnings, error
       FROM preprocessing_runs WHERE dataset_id = $1 ORDER BY created_at DESC`,
    [datasetId],
  );

  return {
    ...toSummary(row),
    storagePath: row.storage_path,
    sha256: row.sha256,
    columns: columns.rows.map((c) => ({
      id: c.id,
      position: c.position,
      name: c.name,
      inferredType: c.inferred_type,
      pandasDtype: c.pandas_dtype,
      nonNullCount: c.non_null_count,
      nullCount: c.null_count,
      nullFraction: Number(c.null_fraction),
      distinctCount: c.distinct_count,
      sampleValues: c.sample_values ?? [],
      minValue: c.min_value,
      maxValue: c.max_value,
      meanValue: c.mean_value,
      isTarget: c.is_target,
    })),
    targetDistribution: row.target_distribution,
    preprocessingRuns: runs.rows.map((r) => ({
      id: r.id,
      mlPreprocessingId: r.ml_preprocessing_id,
      status: r.status,
      encodedFeatureCount: r.encoded_feature_count,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      warnings: (r.warnings as string[]) ?? [],
      error: r.error,
    })),
  };
}

/** Re-read the stored file and re-run inspection and validation. */
export async function revalidateDataset(datasetId: string): Promise<MlInspection> {
  const actor = await requireActor();
  if (!isUuid(datasetId)) throw AppError.notFound("That dataset does not exist.");
  const detail = await getDataset(datasetId);
  if (!detail) throw AppError.notFound("That dataset does not exist.");

  const buffer = await readDatasetFile(detail.storagePath);
  const inspection = await ml.inspect(
    { buffer, filename: detail.originalFilename, contentType: CONTENT_TYPES.csv },
    { targetColumn: detail.targetColumn ?? undefined, previewRows: 25 },
  );
  await storeInspection(datasetId, inspection);

  await recordAudit({
    action: AUDIT.datasetValidated,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "dataset",
    resourceId: datasetId,
    metadata: { errors: inspection.issues.filter((i) => i.severity === "error").length },
  });

  return inspection;
}

export interface PreprocessOptions {
  targetColumn?: string;
  idColumns?: string[];
  testSize?: number;
  stratify?: boolean;
  applySmote?: boolean;
  randomSeed?: number;
}

/** Run the documented preprocessing workflow and record the run. */
export async function preprocessDataset(
  datasetId: string,
  options: PreprocessOptions = {},
): Promise<{ run: PreprocessingRunSummary; result: MlPreprocessResult }> {
  const actor = await requireActor();
  if (!isUuid(datasetId)) throw AppError.notFound("That dataset does not exist.");
  const detail = await getDataset(datasetId);
  if (!detail) throw AppError.notFound("That dataset does not exist.");

  if (detail.status === "invalid" || (detail.errorCount ?? 0) > 0) {
    throw AppError.unprocessable(
      "This dataset has validation errors that must be fixed first.",
      {
        code: "validation_failed",
        nextAction: "Open the validation report and fix the listed problems.",
      },
    );
  }

  const targetColumn = options.targetColumn ?? detail.targetColumn;
  if (!targetColumn) {
    throw AppError.badRequest("No target column has been identified.", {
      code: "missing_target",
      fields: { targetColumn: "Choose the column that records whether a customer churned." },
    });
  }

  // The identifier columns chosen at upload, unless this call overrides them.
  // They decide how customers are keyed and how predictions are matched back, so
  // they are never left to default silently.
  const idColumns =
    options.idColumns && options.idColumns.length > 0
      ? options.idColumns
      : detail.idColumns;

  const db = await getDatabase();
  const buffer = await readDatasetFile(detail.storagePath);

  await db.query("UPDATE datasets SET status = 'preprocessing' WHERE id = $1", [
    datasetId,
  ]);

  // A placeholder row is written first so a crash mid-preprocessing leaves a
  // visible failed run rather than no trace at all.
  const placeholder = await db.query<{ id: string }>(
    `INSERT INTO preprocessing_runs (dataset_id, ml_preprocessing_id, status, started_by)
     VALUES ($1, $2, 'running', $3) RETURNING id`,
    [datasetId, `pending-${Date.now()}`, actor.id],
  );
  const runId = placeholder.rows[0].id;

  try {
    const result = await ml.preprocess(
      { buffer, filename: detail.originalFilename, contentType: CONTENT_TYPES.csv },
      {
        targetColumn,
        idColumns,
        testSize: options.testSize,
        stratify: options.stratify,
        applySmote: options.applySmote,
        randomSeed: options.randomSeed,
      },
    );

    await db.query(
      `UPDATE preprocessing_runs
          SET ml_preprocessing_id = $2, status = 'completed', params = $3::jsonb,
              steps = $4::jsonb, split = $5::jsonb, resample = $6::jsonb,
              encoded_features = $7::jsonb, encoded_feature_count = $8,
              scaler_mean = $9::jsonb, scaler_scale = $10::jsonb,
              warnings = $11::jsonb, completed_at = now()
        WHERE id = $1`,
      [
        runId,
        result.preprocessing_id,
        JSON.stringify(result.params),
        JSON.stringify(result.steps),
        JSON.stringify(result.split),
        JSON.stringify(result.resample),
        JSON.stringify(result.encoded_features),
        result.encoded_feature_count,
        JSON.stringify(result.scaler_mean),
        JSON.stringify(result.scaler_scale),
        JSON.stringify(result.warnings),
      ],
    );
    await db.query("UPDATE datasets SET status = 'preprocessed' WHERE id = $1", [
      datasetId,
    ]);

    await recordAudit({
      action: AUDIT.datasetPreprocessed,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "dataset",
      resourceId: datasetId,
      metadata: {
        preprocessingId: result.preprocessing_id,
        encodedFeatures: result.encoded_feature_count,
        smoteApplied: result.resample.applied,
      },
    });

      return {
      run: {
        id: runId,
        mlPreprocessingId: result.preprocessing_id,
        status: "completed",
        encodedFeatureCount: result.encoded_feature_count,
        createdAt: result.created_at,
        completedAt: new Date().toISOString(),
        warnings: result.warnings,
        error: null,
      },
      result,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Preprocessing failed";
    const stage =
      typeof error === "object" && error !== null && "stage" in error
        ? String((error as { stage: unknown }).stage)
        : "preprocessing";
    await db.query(
      `UPDATE preprocessing_runs
          SET status = 'failed', error = $2, error_stage = $3, completed_at = now()
        WHERE id = $1`,
      [runId, message.slice(0, 1000), stage],
    );
    await db.query("UPDATE datasets SET status = 'failed' WHERE id = $1", [
      datasetId,
    ]);
    await recordAudit({
      action: AUDIT.trainingFailed,
      actorUserId: actor.id,
      actorEmail: actor.email,
      resourceType: "preprocessing_run",
      resourceId: runId,
      outcome: "failure",
      metadata: { stage, error: message.slice(0, 300) },
    });
    throw error;
  }
}

export interface PreprocessingRunDetail {
  id: string;
  datasetId: string;
  mlPreprocessingId: string;
  status: string;
  params: Record<string, unknown>;
  steps: Record<string, unknown>[];
  split: Record<string, unknown> | null;
  resample: Record<string, unknown> | null;
  encodedFeatures: Record<string, unknown>[];
  encodedFeatureCount: number | null;
  scalerMean: Record<string, number>;
  scalerScale: Record<string, number>;
  warnings: string[];
  error: string | null;
  errorStage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function getPreprocessingRun(
  runId: string,
): Promise<PreprocessingRunDetail | null> {
  await requireActor();
  if (!isUuid(runId)) return null;
  const db = await getDatabase();
  const result = await db.query<{
    id: string;
    dataset_id: string;
    ml_preprocessing_id: string;
    status: string;
    params: Record<string, unknown>;
    steps: Record<string, unknown>[];
    split: Record<string, unknown> | null;
    resample: Record<string, unknown> | null;
    encoded_features: Record<string, unknown>[];
    encoded_feature_count: number | null;
    scaler_mean: Record<string, number>;
    scaler_scale: Record<string, number>;
    warnings: string[];
    error: string | null;
    error_stage: string | null;
    created_at: string;
    completed_at: string | null;
  }>("SELECT * FROM preprocessing_runs WHERE id = $1", [runId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    datasetId: row.dataset_id,
    mlPreprocessingId: row.ml_preprocessing_id,
    status: row.status,
    params: row.params,
    steps: row.steps ?? [],
    split: row.split,
    resample: row.resample,
    encodedFeatures: row.encoded_features ?? [],
    encodedFeatureCount: row.encoded_feature_count,
    scalerMean: row.scaler_mean ?? {},
    scalerScale: row.scaler_scale ?? {},
    warnings: row.warnings ?? [],
    error: row.error,
    errorStage: row.error_stage,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Most recent successful preprocessing run for a dataset. */
export async function latestPreprocessingRun(
  datasetId: string,
): Promise<PreprocessingRunDetail | null> {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<{ id: string }>(
    `SELECT id FROM preprocessing_runs
      WHERE dataset_id = $1 AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1`,
    [datasetId],
  );
  return result.rows[0] ? getPreprocessingRun(result.rows[0].id) : null;
}

export async function getDatasetValidation(datasetId: string) {
  await requireActor();
  const db = await getDatabase();
  const result = await db.query<{
    id: string;
    status: string;
    error_count: number;
    warning_count: number;
    info_count: number;
    issues: MlInspection["issues"];
    row_count: number | null;
    column_count: number | null;
    created_at: string;
  }>(
    "SELECT * FROM dataset_validation_results WHERE dataset_id = $1",
    [datasetId],
  );
  return result.rows[0] ?? null;
}

/** Read the stored CSV for a dataset. */
export async function readDatasetFile(relativePath: string): Promise<Buffer> {
  return storage().get(relativePath);
}

export async function softDeleteDataset(datasetId: string): Promise<void> {
  const actor = await requireActor();
  const db = await getDatabase();
  const result = await db.query(
    `UPDATE datasets SET deleted_at = now(), status = 'failed'
      WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [datasetId],
  );
  if (!result.rows.length) {
    throw AppError.notFound("That dataset does not exist or is already deleted.");
  }
  await recordAudit({
    action: AUDIT.datasetDeleted,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "dataset",
    resourceId: datasetId,
  });
}

/**
 * Load a dataset's customers into the database.
 *
 * Runs after preprocessing, because the identifier and target columns are only
 * settled by then. Customer rows are upserted, so re-running refreshes the
 * attributes without creating duplicates.
 */
export interface CustomerLoadSpec {
  /** The column that records whether the customer churned. */
  targetColumn: string;
  /** Column carrying the source system's customer identifier, if any. */
  idColumns: string[];
}

export interface CustomerLoadResult {
  inserted: number;
  updated: number;
  warnings: string[];
}

/** True when the parsed file has a column with this name. */
function frameHasColumn(buffer: Buffer, column: string): boolean {
  const firstLine = buffer.toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t")
    ? "\t"
    : firstLine.split(";").length > firstLine.split(",").length
      ? ";"
      : ",";
  return splitCsvLine(firstLine, delimiter).some(
    (name) => name.trim().toLowerCase() === column.trim().toLowerCase(),
  );
}

export async function loadCustomers(
  datasetId: string,
  spec: CustomerLoadSpec,
): Promise<CustomerLoadResult> {
  const actor = await requireActor();
  const detail = await getDataset(datasetId);
  if (!detail) throw AppError.notFound("That dataset does not exist.");

  const allWarningsForLoad: string[] = [];
  const buffer = await readDatasetFile(detail.storagePath);
  const { targetColumn, idColumns } = spec;

  // A target column that is not in the file is not fatal. The parse below
  // simply records the observed outcome as unknown, which is the honest
  // result for data being scored without a known label.
  if (targetColumn && !frameHasColumn(buffer, targetColumn)) {
    allWarningsForLoad.push(
      `The target column "${targetColumn}" is not in this file, so customers ` +
        "were loaded without a recorded outcome.",
    );
  }

  // The customer rows are read straight from the source file the application
  // already owns, rather than round-tripped through the ML service. Every
  // attribute is kept so the customer detail page can show the real record.
  const rows = parseCsv(buffer, targetColumn, idColumns);
  if (rows.length === 0) {
    throw AppError.unprocessable("No customer rows could be read from the file.");
  }

  const db = await getDatabase();
  let inserted = 0;
  let updated = 0;

  // Batched so a large dataset does not open a transaction per row.
  const BATCH = 250;
  for (let index = 0; index < rows.length; index += BATCH) {
    const batch = rows.slice(index, index + BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((row, offset) => {
      const base = offset * 6;
      values.push(
        datasetId,
        row.externalId,
        JSON.stringify(row.attributes),
        row.displayName,
        row.observedChurn,
        actor.id,
      );
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}::jsonb, $${base + 4}, $${base + 5}::int, $${base + 6}::uuid)`;
    });
    const outcome = await db.query(
      `INSERT INTO customers
         (dataset_id, external_id, attributes, display_name, churn_label_observed,
          loaded_by)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (dataset_id, external_id) DO UPDATE
         SET attributes = EXCLUDED.attributes,
             display_name = EXCLUDED.display_name,
             churn_label_observed = EXCLUDED.churn_label_observed,
             updated_at = now()
       RETURNING (xmax = 0) AS was_inserted`,
      values,
    );
    for (const row of outcome.rows as unknown as { was_inserted: boolean }[]) {
      if (row.was_inserted) inserted += 1;
      else updated += 1;
    }
  }

  await recordAudit({
    action: AUDIT.datasetUploaded,
    actorUserId: actor.id,
    actorEmail: actor.email,
    resourceType: "dataset",
    resourceId: datasetId,
    metadata: {
      event: "customers_loaded",
      inserted,
      updated,
      warnings: allWarningsForLoad.length,
    },
  });

  return { inserted, updated, warnings: allWarningsForLoad };
}

/** Read a stored dataset's first rows, for the preview page. */
export async function getDatasetPreview(
  datasetId: string,
  limit = 25,
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; total: number }> {
  await requireActor();
  if (!isUuid(datasetId)) return { columns: [], rows: [], total: 0 };
  const detail = await getDatasetForPreview(datasetId);
  if (!detail) return { columns: [], rows: [], total: 0 };

  const buffer = await readDatasetFile(detail.storage_path);
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  const headerLine = lines[0] ?? "";
  const delimiter = headerLine.includes("\t")
    ? "\t"
    : headerLine.split(";").length > headerLine.split(",").length
      ? ";"
      : ",";
  const columns = splitCsvLine(headerLine, delimiter).map((name) => name.trim());
  const targetColumn = detail.target_column ?? "";

  const rows: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    if (rows.length >= limit) break;
    const values = splitCsvLine(line, delimiter);
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column] = values[index] ?? null;
    });
    rows.push(record);
  }

  const total = lines.slice(1).filter((line) => line.trim() !== "").length;
  void targetColumn;

  return { columns, rows, total };
}

async function getDatasetForPreview(
  datasetId: string,
): Promise<{ storage_path: string; target_column: string | null } | null> {
  const db = await getDatabase();
  const result = await db.query<{ storage_path: string; target_column: string | null }>(
    `SELECT storage_path, target_column FROM datasets
      WHERE id = $1 AND deleted_at IS NULL`,
    [datasetId],
  );
  return result.rows[0] ?? null;
}

interface ParsedCustomerRow {
  externalId: string;
  displayName: string | null;
  observedChurn: number | null;
  attributes: Record<string, unknown>;
}

/**
 * Parse the source CSV into customer rows.
 *
 * Written here rather than delegated, because it is a plain read of a file the
 * application already owns, and it keeps every customer attribute available for
 * the detail page without a second service call.
 */
export function parseCsv(
  buffer: Buffer,
  targetColumn: string,
  idColumns: string[],
): ParsedCustomerRow[] {
  const text = buffer.toString("utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t")
    ? "\t"
    : firstLine.split(";").length > firstLine.split(",").length
      ? ";"
      : ",";

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0], delimiter);
  const targetIndex = header.findIndex(
    (name) => name.trim().toLowerCase() === targetColumn.trim().toLowerCase(),
  );
  const idIndex = idColumns.length
    ? header.findIndex((name) => name.trim() === idColumns[0].trim())
    : -1;

  const rows: ParsedCustomerRow[] = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const values = splitCsvLine(lines[lineIndex], delimiter);
    if (values.length !== header.length) continue;

    const externalId =
      idIndex >= 0 && values[idIndex]
        ? values[idIndex].trim()
        : `row-${lineIndex}`;

    const attributes: Record<string, unknown> = {};
    for (let column = 0; column < header.length; column += 1) {
      if (column === targetIndex) continue;
      attributes[header[column].trim()] = values[column];
    }

    const targetValue =
      targetIndex >= 0 ? values[targetIndex].trim().toLowerCase() : "";

    rows.push({
      externalId,
      displayName: idIndex >= 0 ? values[idIndex].trim() : `Customer ${lineIndex}`,
      observedChurn:
        targetValue === "yes" ? 1 : targetValue === "no" ? 0 : null,
      attributes,
    });
  }
  return rows;
}

/** Split one CSV line, honouring double-quoted fields containing delimiters. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
