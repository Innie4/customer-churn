import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * PGlite is a build of PostgreSQL compiled to WebAssembly, and it runs its
   * database in a worker thread, passing file locations across the thread
   * boundary.
   *
   * When the bundler inlines it, those locations arrive as a `URL` built in a
   * different realm, and Node's own `fs` rejects them:
   *
   *   TypeError: The "path" argument must be of type string or an instance of
   *   Buffer or URL. Received an instance of URL
   *
   * The failure surfaces as an unhandled rejection, so it does not point at the
   * database: every API route keeps working, and only the pages, which render
   * while the background work is in flight, return 500. The standalone scripts,
   * which load PGlite outside the bundler, are unaffected.
   *
   * Opting out leaves PGlite to be required as real Node code, which is what it
   * needs. See the Next.js documentation on package bundling.
   */
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
