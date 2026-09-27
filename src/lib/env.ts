/**
 * Runtime configuration.
 *
 * Every environment variable the application reads is declared once in
 * env-specs.ts, and read here. Nothing else in the codebase touches
 * process.env for configuration, so those two files together are the complete
 * list of what the application depends on.
 *
 * The specification is kept in a separate module so the documentation generator
 * can produce .env.example and ENVIRONMENT.md from the same list this file
 * reads, without importing server-only code.
 *
 * Values are read on the server only. Nothing marked secret is ever exported to
 * a client component.
 */

import "server-only";

import { ENV_SPECS, type AppEnvironment, type EnvVarSpec } from "./env-specs";

export { ENV_SPECS };
export type { AppEnvironment, EnvVarSpec };

function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function readWithDefault(name: string, fallback: string): string {
  return read(name) ?? fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  get nodeEnv(): AppEnvironment {
    const value = read("NODE_ENV");
    return value === "production" || value === "test" ? value : "development";
  },

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  },

  get isTest(): boolean {
    return this.nodeEnv === "test";
  },

  appUrl: readWithDefault("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),

  get sessionSecret(): string {
    return read("SESSION_SECRET") ?? "";
  },

  sessionTtlHours: readNumber("SESSION_TTL_HOURS", 8),
  passwordResetTtlMinutes: readNumber("PASSWORD_RESET_TTL_MINUTES", 30),

  get databaseUrl(): string | undefined {
    return read("DATABASE_URL");
  },

  get databaseDriver(): "auto" | "pglite" | "postgres" {
    const value = read("DATABASE_DRIVER");
    return value === "pglite" || value === "postgres" ? value : "auto";
  },

  get databaseSsl(): boolean {
    return read("DATABASE_SSL") === "true";
  },

  storageDir: readWithDefault("STORAGE_DIR", "storage"),
  maxUploadBytes: readNumber("MAX_UPLOAD_BYTES", 25 * 1024 * 1024),

  mlServiceUrl: readWithDefault("ML_SERVICE_URL", "http://127.0.0.1:8000"),
  mlServiceApiKey: read("ML_SERVICE_API_KEY"),
  mlRequestTimeoutMs: readNumber("ML_REQUEST_TIMEOUT_MS", 600_000),
  mlShapSampleSize: readNumber("ML_SHAP_SAMPLE_SIZE", 1000),

  emailProvider: readWithDefault("EMAIL_PROVIDER", "log"),
  emailFrom: read("EMAIL_FROM"),
  emailApiKey: read("EMAIL_PROVIDER_API_KEY"),
} as const;

export interface ConfigProblem {
  variable: string;
  message: string;
}

/**
 * Validate the configuration the current environment actually needs.
 *
 * Only the requirements that apply right now are reported, so a local developer
 * is not told to configure production-only settings and a production deploy is
 * never allowed to start with a missing secret.
 */
export function validateConfig(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (env.sessionSecret.length === 0) {
    problems.push({
      variable: "SESSION_SECRET",
      message:
        "Not set. Generate one with `openssl rand -base64 32`. Sessions " +
        "cannot be signed without it.",
    });
  } else if (env.sessionSecret.length < 32) {
    problems.push({
      variable: "SESSION_SECRET",
      message: `Too short (${env.sessionSecret.length} characters). Use at least 32.`,
    });
  } else if (env.isProduction && env.sessionSecret.startsWith("test-")) {
    problems.push({
      variable: "SESSION_SECRET",
      message:
        "Looks like the test placeholder. Generate a real secret before deploying.",
    });
  }

  if (env.isProduction && !env.databaseUrl) {
    problems.push({
      variable: "DATABASE_URL",
      message:
        "Not set. Production requires a PostgreSQL connection string; the " +
        "embedded database is for local work only.",
    });
  }

  if (env.isProduction && !env.mlServiceUrl.startsWith("https://")) {
    problems.push({
      variable: "ML_SERVICE_URL",
      message: "Should be an https URL in production.",
    });
  }

  if (env.emailProvider !== "log" && !env.emailApiKey) {
    problems.push({
      variable: "EMAIL_PROVIDER_API_KEY",
      message: `Required because EMAIL_PROVIDER is '${env.emailProvider}'.`,
    });
  }

  if (env.emailProvider === "log" && env.isProduction) {
    problems.push({
      variable: "EMAIL_PROVIDER",
      message:
        "Set to a real provider for production. With 'log', password reset " +
        "links are only written to the server log and never reach a user.",
    });
  }

  if (env.maxUploadBytes <= 0) {
    problems.push({
      variable: "MAX_UPLOAD_BYTES",
      message: "Must be greater than zero.",
    });
  }

  return problems;
}

export function assertConfig(): void {
  const problems = validateConfig();
  if (problems.length === 0) return;
  const detail = problems
    .map((problem) => `  - ${problem.variable}: ${problem.message}`)
    .join("\n");
  throw new Error(`Configuration is not usable:\n${detail}`);
}
