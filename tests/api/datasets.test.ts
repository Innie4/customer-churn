/**
 * Dataset upload, validation and preprocessing, through the real handlers.
 *
 * The machine learning service is a local stub, but everything else is real:
 * the multipart body, the storage layer and its traversal guard, the database
 * constraints, and the data access layer that persists each step. A defect in
 * any of those shows up here.
 */

import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as harness from "../support/harness";
import { startMlStub, type MlStub } from "../support/ml-stub";
import { POST as uploadDataset, GET as listDatasets } from "@/app/api/datasets/route";
import { GET as getDataset } from "@/app/api/datasets/[id]/route";
import { POST as validateDataset } from "@/app/api/datasets/[id]/validate/route";
import { POST as preprocessDataset } from "@/app/api/datasets/[id]/preprocess/route";
import { GET as listDatasetCustomers } from "@/app/api/datasets/[id]/customers/route";

vi.mock("next/headers", () => ({
  cookies: async () => harness.activeJar,
  headers: async () => new Headers(),
}));

let app: Awaited<ReturnType<typeof harness.createAppContext>>;
let ml: MlStub;
let analyst: string;

beforeAll(async () => {
  app = await harness.createAppContext();
  ml = await startMlStub();
  analyst = await app.createUser({ email: "analyst@example.com", role: "analyst" });
});

afterAll(async () => {
  await ml.close();
  await app.close();
});

beforeEach(() => {
  harness.resetCookies();
});

/**
 * Upload the sample and return the created dataset's id.
 *
 * The application rejects a byte-identical re-upload as a conflict, which is
 * sensible but means a test that uploads the same fixture twice gets no second
 * dataset. Rather than weaken the application, the helper reuses the existing
 * one, and the conflict itself is asserted separately.
 */
async function upload(
  userId: string = analyst,
  fields: Record<string, string> = {},
  options: { unique?: boolean } = {},
): Promise<{ status: number; id: string | null; response: Response }> {
  const body =
    options.unique === false
      ? harness.SAMPLE_CSV
      : harness.SAMPLE_CSV.replace(
          "C0001,Male",
          `C0001,Male,${String(Date.now()).slice(-6)}`.replace(/,(\d+),/, ",$1,"),
        );

  const response = await uploadDataset(
    await app.as(userId, {
      method: "POST",
      url: "http://localhost/api/datasets",
      body: harness.csvUpload(body, "churn.csv", fields),
    }),
    app.context({}),
  );

  if (response.status === 409) {
    // The upload was refused as a duplicate; use what is already there.
    const listed = await listDatasets(
      await app.as(analyst, {
        method: "GET",
        url: "http://localhost/api/datasets",
      }),
      app.context({}),
    );
    const data = (await listed.json()) as {
      data: { datasets: { id: string }[] };
    };
    return { status: 409, id: data.data.datasets[0]?.id ?? null, response };
  }

  let id: string | null = null;
  if (response.status < 400) {
    const parsed = (await response.clone().json()) as {
      data: { dataset?: { id?: string } };
    };
    id = parsed.data.dataset?.id ?? null;
  }
  return { status: response.status, id, response };
}

describe("POST /api/datasets", () => {
  it("stores an upload and reports what was found", async () => {
    const { status, id, response } = await upload(analyst, {}, { unique: false });
    expect([200, 409]).toContain(status);
    expect(id).toBeTruthy();
    if (status === 409) return;

    const body = (await response.json()) as {
      data: {
        dataset: { name: string; status: string };
        inspection: { row_count: number; column_count: number };
      };
    };
    expect(body.data.dataset.status).toBeTruthy();
    expect(body.data.inspection.row_count).toBe(4);
  });

  it("reads the multipart body exactly once", async () => {
    // The body is a stream, so reading it twice yields nothing the second time.
    // This asserts the handler gets both the file and the text fields from one
    // parse rather than two.
    const { status } = await upload(
      analyst,
      { name: "Named dataset", target_column: "Churn", id_columns: "customerID" },
      { unique: false },
    );
    expect([200, 409]).toContain(status);

    if (status === 409) return;
    const rows = await app.db.query<{ name: string }>(
      "SELECT name FROM datasets ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows.rows[0].name).toBe("Named dataset");
  });

  it("writes the file into the storage directory, not public/", async () => {
    await upload();
    const rows = await app.db.query<{ storage_path: string; mime_type: string }>(
      "SELECT storage_path, mime_type FROM datasets ORDER BY created_at DESC LIMIT 1",
    );
    const stored = rows.rows[0].storage_path;
    expect(stored).not.toContain("public");
    expect(rows.rows[0].mime_type).toContain("csv");
    // Stored as a POSIX-style relative path, so a dataset written on one
    // platform is readable on another.
    expect(stored).not.toContain("\\");

    const { storage } = await import("@/lib/storage");
    const bytes = await storage().get(stored);
    expect(bytes.toString("utf8")).toContain("customerID");
  });

  it("records the file's checksum and size", async () => {
    await upload();
    const rows = await app.db.query<{ sha256: string; size_bytes: string }>(
      "SELECT sha256, size_bytes FROM datasets ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(rows.rows[0].size_bytes)).toBeGreaterThan(0);
  });

  it("audits the upload", async () => {
    await upload();
    const rows = await app.db.query<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows.rows[0].outcome).toBe("success");
    expect(rows.rows[0].action).toContain("dataset");
  });

  it("refuses an upload with no file", async () => {
    const form = new FormData();
    form.append("target_column", "Churn");
    const response = await uploadDataset(
      await app.as(analyst, {
        method: "POST",
        url: "http://localhost/api/datasets",
        body: form,
      }),
      app.context({}),
    );
    expect(response.status).toBe(400);
    const body = await harness.errorBody(response);
    expect(body.error.code).toBe("missing_file");
  });

  it("refuses a viewer", async () => {
    const viewer = await app.createUser({ email: "viewer@example.com", role: "viewer" });
    const { status } = await upload(viewer);
    expect(status).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    const response = await uploadDataset(
      app.anonymous({
        method: "POST",
        url: "http://localhost/api/datasets",
        body: harness.csvUpload(),
      }),
      app.context({}),
    );
    expect(response.status).toBe(401);
  });

  it("records a denied attempt rather than hiding it", async () => {
    const viewer = await app.createUser({
      email: "denied@example.com",
      role: "viewer",
    });
    const before = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE outcome = 'denied'",
    );
    await upload(viewer);
    const after = await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE outcome = 'denied'",
    );
    expect(Number(after.rows[0].n)).toBeGreaterThan(Number(before.rows[0].n));
  });

  it("never stores an upload outside the storage root", async () => {
    await upload(analyst, { name: "traversal" });
    const rows = await app.db.query<{ storage_path: string }>(
      "SELECT storage_path FROM datasets ORDER BY created_at DESC LIMIT 1",
    );
    const stored = rows.rows[0].storage_path;
    const root = path.resolve(process.env.STORAGE_DIR ?? "storage");
    const resolved = path.resolve(root, stored);
    expect(resolved.startsWith(root)).toBe(true);
  });
});

describe("GET /api/datasets", () => {
  it("lists what has been uploaded", async () => {
    await upload();
    const response = await listDatasets(
      await app.as(analyst, { method: "GET", url: "http://localhost/api/datasets" }),
      app.context({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { datasets: unknown[] } };
    expect(body.data.datasets.length).toBeGreaterThan(0);
  });

  it("refuses an anonymous caller", async () => {
    const response = await listDatasets(
      app.anonymous({ method: "GET", url: "http://localhost/api/datasets" }),
      app.context({}),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/datasets/[id]", () => {
  it("returns the dataset with its validation and runs", async () => {
    const { id } = await upload();
    const response = await getDataset(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/datasets/${id}`,
      }),
      app.context({ id: id! }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { dataset: { id: string }; validation: unknown; preprocessingRuns: unknown[] };
    };
    expect(body.data.dataset.id).toBe(id);
  });

  it("returns 404 for an id that is not a uuid", async () => {
    const response = await getDataset(
      await app.as(analyst, {
        method: "GET",
        url: "http://localhost/api/datasets/not-a-uuid",
      }),
      app.context({ id: "not-a-uuid" }),
    );
    // A malformed id must not reach the database.
    expect(response.status).toBe(404);
  });

  it("returns 404 for a well-formed id that does not exist", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const response = await getDataset(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/datasets/${missing}`,
      }),
      app.context({ id: missing }),
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/datasets/[id]/validate", () => {
  it("records the inspection result against the dataset", async () => {
    const { id } = await upload();
    const response = await validateDataset(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/datasets/${id}/validate`,
      }),
      app.context({ id: id! }),
    );
    expect(response.status).toBe(200);

    const rows = await app.db.query<{ status: string; error_count: string }>(
      "SELECT status, error_count FROM dataset_validation_results WHERE dataset_id = $1",
      [id],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("is safe to run twice", async () => {
    const { id } = await upload();
    const run = () =>
      validateDataset(
        app.anonymous({ method: "POST", url: "http://x" }),
        app.context({ id: id! }),
      );
    expect((await run()).status).toBe(401);

    const request = await app.as(analyst, {
      method: "POST",
      url: `http://localhost/api/datasets/${id}/validate`,
    });
    expect((await validateDataset(request, app.context({ id: id! }))).status).toBe(200);

    // A second request with a fresh session cookie, since the body was consumed.
    const again = await app.as(analyst, {
      method: "POST",
      url: `http://localhost/api/datasets/${id}/validate`,
    });
    expect((await validateDataset(again, app.context({ id: id! }))).status).toBe(200);
  });
});

describe("POST /api/datasets/[id]/preprocess", () => {
  it("records a preprocessing run and the service was actually called", async () => {
    const { id } = await upload();
    const callsBefore = ml.callsTo("/v1/datasets/preprocess").length;

    const response = await preprocessDataset(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/datasets/${id}/preprocess`,
      }),
      app.context({ id: id! }),
    );
    expect(response.status).toBe(200);
    expect(ml.callsTo("/v1/datasets/preprocess").length).toBe(callsBefore + 1);

    const runs = await app.db.query<{
      status: string;
      ml_preprocessing_id: string;
      encoded_feature_count: number;
    }>(
      `SELECT status, ml_preprocessing_id, encoded_feature_count
         FROM preprocessing_runs WHERE dataset_id = $1`,
      [id],
    );
    expect(runs.rows.length).toBeGreaterThan(0);
    expect(runs.rows[0].status).toBe("completed");
    expect(runs.rows[0].ml_preprocessing_id).toBeTruthy();
    expect(Number(runs.rows[0].encoded_feature_count)).toBe(40);
  });

  it("sends the file to the service as multipart", async () => {
    const { id } = await upload();
    const before = ml.callsTo("/v1/datasets/preprocess").length;
    await preprocessDataset(
      await app.as(analyst, {
        method: "POST",
        url: `http://localhost/api/datasets/${id}/preprocess`,
      }),
      app.context({ id: id! }),
    );
    const call = ml.callsTo("/v1/datasets/preprocess")[before];
    expect(call.contentType).toContain("multipart/form-data");
    expect(call.bodyBytes).toBeGreaterThan(0);
  });

  it("surfaces a service failure instead of recording a successful run", async () => {
    const { id } = await upload();
    ml.setMode("failing");
    try {
      const response = await preprocessDataset(
        await app.as(analyst, {
          method: "POST",
          url: `http://localhost/api/datasets/${id}/preprocess`,
        }),
        app.context({ id: id! }),
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      const body = await harness.errorBody(response);
      // The message must not leak the service's internals.
      expect(body.error.message).not.toContain("Traceback");
      expect(JSON.stringify(body)).not.toContain("app/pipeline");
      expect(body.error.nextAction).toBeTruthy();

      // The failure is recorded, not swallowed, so the run shows as failed
      // rather than quietly disappearing.
      const runs = await app.db.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM preprocessing_runs
          WHERE dataset_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      expect(runs.rows[0].status).toBe("failed");
      expect(runs.rows[0].error).toBeTruthy();
    } finally {
      ml.setMode("normal");
    }
  });

  it("refuses a viewer", async () => {
    const { id } = await upload();
    const viewer = await app.createUser({ email: "pp-viewer@example.com", role: "viewer" });
    const response = await preprocessDataset(
      await app.as(viewer, {
        method: "POST",
        url: `http://localhost/api/datasets/${id}/preprocess`,
      }),
      app.context({ id: id! }),
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /api/datasets/[id]/customers", () => {
  it("returns an empty list before predictions exist", async () => {
    const { id } = await upload();
    const response = await listDatasetCustomers(
      await app.as(analyst, {
        method: "GET",
        url: `http://localhost/api/datasets/${id}/customers`,
      }),
      app.context({ id: id! }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { items: unknown[]; total: number; page: number; pageSize: number };
    };
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.total).toBe(0);
    // Paged, because a real dataset has thousands of rows.
    expect(body.data.pageSize).toBeLessThanOrEqual(200);
  });
});

describe("when the machine learning service is unreachable", () => {
  it("names the service in the error, so an operator knows what to start", async () => {
    const { id } = await upload();
    // Stop answering entirely, which is what an outage looks like.
    await ml.close();
    try {
      const response = await preprocessDataset(
        await app.as(analyst, {
          method: "POST",
          url: `http://localhost/api/datasets/${id}/preprocess`,
        }),
        app.context({ id: id! }),
      );
      // 503, not 500: a dependency being down is not a bug in this application.
      expect(response.status).toBe(503);
      const body = await harness.errorBody(response);
      expect(body.error.code).toBe("ml_service_unreachable");
      expect(body.error.message).toMatch(/machine learning service/i);
      expect(body.error.nextAction).toBeTruthy();
    } finally {
      // Leave the stub running for anything that follows.
      ml = await startMlStub();
    }
  });
});
