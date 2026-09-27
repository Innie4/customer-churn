/**
 * Client-safe request identifiers.
 *
 * Mirrors the server's `newRequestId` so an error boundary on the client can
 * produce a reference to quote in a bug report, without importing server-only
 * code into the browser bundle.
 */

let counter = 0;

export function newRequestId(): string {
  counter = (counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}
