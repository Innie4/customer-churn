/**
 * The configuration specification.
 *
 * Pure data: no environment reads, no `server-only` marker. Keeping it separate
 * from `env.ts` means the documentation generator can produce `.env.example`
 * and `ENVIRONMENT.md` from the same list the application reads at runtime, so
 * the two cannot drift apart.
 */

export type AppEnvironment = "development" | "test" | "production";

export interface EnvVarSpec {
  name: string;
  required: boolean;
  /** Shown in ENVIRONMENT.md. */
  purpose: string;
  /** Where the value comes from. */
  source: string;
  /** Which part of the system reads it. */
  usedBy: string;
  /** Whether it is safe to send to a browser. */
  browserSafe: boolean;
  defaultValue?: string;
}

export const ENV_SPECS: readonly EnvVarSpec[] = [
  {
    name: "DEMO_ACCOUNT_PASSWORD",
    required: false,
    purpose:
      "Shared password for the demo accounts offered on the sign-in page, " +
      "which can be opened with one click instead of being typed. When this " +
      "is unset those accounts are not offered and the endpoint refuses. " +
      "Set locally only; it must never hold a real credential.",
    source: "Demo seed script, read back by the demo launcher",
    usedBy: "Demo sign-in",
    browserSafe: false,
  },
  {
    name: "SIMULATED_MODE",
    required: false,
    purpose:
      "When 'true', the machine learning service is stood in for by an " +
      "in-process simulator, so the whole application can be browsed without " +
      "Python running. Every model metric, probability and explanation is " +
      "generated rather than learned, and the pages label it as simulated. " +
      "Nothing else about the application changes: the same pages, data " +
      "layer, schema, sessions and audit trail are used. Never enable this in " +
      "production.",
    source: "Operator",
    usedBy: "ML client",
    browserSafe: true,
    defaultValue: "false",
  },
  {
    name: "NODE_ENV",
    required: false,
    purpose: "Runtime mode. Set automatically by the deployment platform.",
    source: "Framework",
    usedBy: "Next.js",
    browserSafe: true,
    defaultValue: "development",
  },
  {
    name: "NEXT_PUBLIC_APP_URL",
    required: false,
    purpose:
      "Public origin of the application, used for links in emails and redirects.",
    source: "Deployment platform",
    usedBy: "Auth, email provider",
    browserSafe: true,
    defaultValue: "http://localhost:3000",
  },
  {
    name: "DATABASE_URL",
    required: false,
    purpose:
      "PostgreSQL connection string. When unset the application uses an " +
      "embedded PostgreSQL build (PGlite) under .data/postgres, which is " +
      "suitable for local work and tests but not for production.",
    source: "Managed PostgreSQL provider",
    usedBy: "Database client",
    browserSafe: false,
  },
  {
    name: "DATABASE_DRIVER",
    required: false,
    purpose:
      "Forces a driver. 'pglite' uses the embedded database; 'postgres' uses DATABASE_URL.",
    source: "Operator",
    usedBy: "Database client",
    browserSafe: false,
    defaultValue: "auto",
  },
  {
    name: "DATABASE_SSL",
    required: false,
    purpose: "Set to 'true' to require TLS on the PostgreSQL connection.",
    source: "Managed PostgreSQL provider",
    usedBy: "Database client",
    browserSafe: false,
    defaultValue: "false",
  },
  {
    name: "DATABASE_POOL_MAX",
    required: false,
    purpose: "Maximum pooled PostgreSQL connections per process.",
    source: "Operator",
    usedBy: "Database client",
    browserSafe: false,
    defaultValue: "10",
  },
  {
    name: "SESSION_SECRET",
    required: true,
    purpose:
      "Secret used to derive session and cookie signing keys. Must be at " +
      "least 32 characters. Rotating it invalidates every existing session.",
    source: "Operator, generated with `openssl rand -base64 32`",
    usedBy: "Authentication",
    browserSafe: false,
  },
  {
    name: "SESSION_TTL_HOURS",
    required: false,
    purpose:
      "How long a session stays valid before the user must sign in again.",
    source: "Operator",
    usedBy: "Authentication",
    browserSafe: false,
    defaultValue: "8",
  },
  {
    name: "PASSWORD_RESET_TTL_MINUTES",
    required: false,
    purpose: "Lifetime of a password reset token.",
    source: "Operator",
    usedBy: "Authentication",
    browserSafe: false,
    defaultValue: "30",
  },
  {
    name: "STORAGE_DIR",
    required: false,
    purpose:
      "Directory for uploaded datasets, generated reports and chart images.",
    source: "Operator",
    usedBy: "File storage",
    browserSafe: false,
    defaultValue: "storage",
  },
  {
    name: "MAX_UPLOAD_BYTES",
    required: false,
    purpose: "Largest accepted dataset upload, in bytes.",
    source: "Operator",
    usedBy: "Dataset upload",
    browserSafe: false,
    defaultValue: "26214400",
  },
  {
    name: "ML_SERVICE_URL",
    required: true,
    purpose: "Base URL of the Python machine learning service.",
    source: "Operator",
    usedBy: "ML client",
    browserSafe: false,
    defaultValue: "http://127.0.0.1:8000",
  },
  {
    name: "ML_SERVICE_API_KEY",
    required: false,
    purpose:
      "Shared secret presented to the ML service. Optional for local " +
      "development; required whenever ML_REQUIRE_API_KEY is set on the service.",
    source: "Operator, must match the ML service",
    usedBy: "ML client",
    browserSafe: false,
  },
  {
    name: "ML_REQUEST_TIMEOUT_MS",
    required: false,
    purpose: "Timeout for a single call to the ML service.",
    source: "Operator",
    usedBy: "ML client",
    browserSafe: false,
    defaultValue: "600000",
  },
  {
    name: "ML_SHAP_SAMPLE_SIZE",
    required: false,
    purpose: "Customers sampled for a global SHAP explanation.",
    source: "Operator",
    usedBy: "ML client",
    browserSafe: false,
    defaultValue: "1000",
  },
  {
    name: "EMAIL_PROVIDER",
    required: false,
    purpose:
      "Which transactional email provider to use. 'log' writes messages to the server log.",
    source: "Operator",
    usedBy: "Email provider",
    browserSafe: false,
    defaultValue: "log",
  },
  {
    name: "EMAIL_PROVIDER_API_KEY",
    required: false,
    purpose:
      "API key for the transactional email provider used to deliver password " +
      "reset links. Without it, reset links are written to the server log " +
      "instead of emailed, which is only appropriate for local work.",
    source: "Email provider dashboard",
    usedBy: "Email provider",
    browserSafe: false,
  },
  {
    name: "EMAIL_FROM",
    required: false,
    purpose: "From address for transactional email.",
    source: "Operator",
    usedBy: "Email provider",
    browserSafe: false,
  },
  {
    name: "SEED_ADMIN_EMAIL",
    required: false,
    purpose: "Email of the administrator created by the seed script.",
    source: "Operator",
    usedBy: "Seed script",
    browserSafe: false,
  },
  {
    name: "SEED_ADMIN_PASSWORD",
    required: false,
    purpose:
      "Password for the seeded administrator. Only read by the seed script.",
    source: "Operator",
    usedBy: "Seed script",
    browserSafe: false,
  },
];
