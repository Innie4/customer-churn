import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `.mts` so the file is loaded as an ES module. With the `.ts` extension Vite
// treats it as CommonJS and warns that the default loader will change.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
      // The real `server-only` package throws unless the importer is a React
      // server component, which no test module is. It is replaced with an empty
      // module so the server modules under test can be loaded.
      "server-only": path.resolve(rootDir, "tests/support/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    // One file at a time.
    //
    // The application's configuration is read once at import, so the machine
    // learning stub has to listen on a fixed port. Running files in parallel
    // would put several workers on that port at once. Sequential execution is
    // also closer to how a developer runs the suite locally.
    fileParallelism: false,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    // The database suite boots a real PostgreSQL build and runs eight
    // migrations, so it needs more than the default five-second budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}", "db/**/*.ts"],
      exclude: ["**/*.d.ts", "src/**/*.test.*"],
    },
  },
});
