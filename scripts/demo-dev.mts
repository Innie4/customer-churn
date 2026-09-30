/**
 * Start the application in simulated mode.
 *
 * Runs `next dev` with the machine learning service stood in for, so the whole
 * platform can be browsed with no Python installed and nothing listening on port
 * 8000. The environment variable is set here rather than in a shell profile so
 * it cannot leak into a normal `npm run dev` by accident.
 *
 *   npm run demo:dev
 *
 * Requires the demo world to exist:
 *   npm run demo:seed
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

process.env.SIMULATED_MODE = "true";

const credentialsFile = path.join(process.cwd(), ".data", "demo-credentials.txt");

function readCredentials(): { email: string; password: string } | null {
  if (!existsSync(credentialsFile)) return null;
  const lines = readFileSync(credentialsFile, "utf8").split(/\r?\n/);
  const password = lines.find((line) => line.startsWith("password="))?.slice("password=".length);
  // The email is optional: the accounts are listed on the page itself now, so
  // the file only has to carry the password that enables the one-click sign-in.
  const email =
    lines.find((line) => line.startsWith("email="))?.slice("email=".length) ??
    "one of the demo accounts on the page";
  return password ? { email, password } : null;
}

const credentials = readCredentials();

/**
 * Hand the shared demo password to the application.
 *
 * The sign-in page only offers the one-click accounts when it can see this
 * variable, so a deployment that never had it set has the feature switched off
 * rather than merely hidden. The value comes from the file the seed wrote,
 * which is under `.data` and ignored by Git, so no credential is ever passed on
 * a command line or committed.
 */
if (!process.env.DEMO_ACCOUNT_PASSWORD && credentials?.password) {
  process.env.DEMO_ACCOUNT_PASSWORD = credentials.password;
}

process.stdout.write(
  [
    "",
    "  Churn Intelligence — simulated mode",
    "",
    "  The machine learning service is stood in for in this process. Every",
    "  model metric, probability and SHAP value is generated, not learned,",
    "  and the pages carry a banner saying so.",
    "",
    ...(credentials
      ? [
          "  Open http://localhost:3000 and click either demo account. No",
          "  password is needed.",
          "",
        ]
      : [
          "  No demo world found. Build one with:  npm run demo:seed",
          "",
        ]),
  ].join("\n") + "\n",
);

/**
 * Run the local Next.js CLI with the current Node binary.
 *
 * Going through `npx` needs a shell on Windows to resolve the `.cmd` shim,
 * which Node rejects for unescaped arguments; naming the shim directly instead
 * fails outright with EINVAL. The CLI script is a plain Node file, so invoking
 * it with this process's own interpreter avoids both problems and always runs
 * the version installed in this repository rather than a global one.
 */
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) {
  process.stderr.write(
    "Could not find the Next.js CLI. Run `npm install` first.\n",
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [nextBin, "dev", ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

// Signals are forwarded so Ctrl-C stops the dev server rather than orphaning it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
