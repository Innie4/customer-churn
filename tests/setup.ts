/**
 * Test setup.
 *
 * Sets the environment the application reads so a test run never depends on a
 * developer's local `.env`. Every value here is a test-only placeholder; none
 * of them is a real credential.
 */

// NODE_ENV is readonly in the type definitions; vitest already sets it to "test".
if (!process.env.NODE_ENV) {
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
}

// An isolated embedded database, so tests never touch developer data.
(process.env as Record<string, string | undefined>).DATABASE_DRIVER = "pglite";
delete process.env.DATABASE_URL;

// A throwaway artifact tree for anything the tests write to disk.
process.env.STORAGE_DIR ??= ".data/test-storage";

// Deterministic signing key. 32 bytes, and explicitly not a real secret.
process.env.SESSION_SECRET ??=
  "test-only-session-secret-do-not-use-anywhere-0123456789";

process.env.SESSION_TTL_HOURS ??= "1";

/**
 * The machine learning service is replaced by a local stub in application
 * tests, on a fixed port.
 *
 * The port is fixed rather than ephemeral because the application's
 * configuration is read once when its modules are first imported, so the URL
 * has to be in the environment before any module under test is evaluated. The
 * stub binds this port in `beforeAll`.
 */
process.env.ML_SERVICE_URL ??= "http://127.0.0.1:18080";

// The stub is only reachable if an API key is presented when it asks for one.
// The suite runs without a key, so the routes are open; the enforced case is
// covered by the ML service's own tests.
process.env.ML_SERVICE_API_KEY ??= "";
