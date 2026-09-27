/**
 * Cookie names, in one place.
 *
 * Kept in a module with no server-only imports so the proxy can read it without
 * pulling the database client into the proxy bundle.
 */

export const SESSION_COOKIE = "churn_session";
export const SESSION_TTL_COOKIE = "churn_session_ttl";
