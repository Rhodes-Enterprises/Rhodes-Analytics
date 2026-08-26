#!/usr/bin/env node
/**
 * Umbrella dashboard-audit runner (`pnpm run audit:all`).
 *
 * Discovers every `audit:*` script in this package's package.json (except
 * `audit:all` itself) and runs each one SEQUENTIALLY — never in parallel —
 * because the Snowflake connector proxy rate-limits at ~10 requests/second
 * and concurrent audits trigger 429s. New audit scripts are picked up
 * automatically the moment they are added to package.json; nothing here
 * needs to change, so no audit can be forgotten.
 *
 * Self-contained by default: it BUILDS the api-server from the current
 * source and boots a private copy on AUDIT_PORT (default 8099), so the
 * audits always test the code being shipped — never a stale or stopped dev
 * server. Set AUDIT_API_BASE to skip that and audit an already-running
 * server instead.
 *
 * All audits run even if an earlier one fails (you see the full damage
 * report in one pass), then the runner exits 1 if ANY audit failed — or if
 * the build or server boot itself fails.
 *
 * Run from artifacts/api-server:
 *   pnpm run audit:all
 *
 * Env:
 *   AUDIT_API_BASE  audit this base URL instead of booting a private server
 *   AUDIT_PORT      port for the private server (default 8099)
 *   AUDIT_PAUSE_MS  pause between consecutive audits so the proxy's
 *                   rate-limit window clears (default 2000)
 *   (plus everything the individual audits honor: AUDIT_TOLERANCE_PCT, ...)
 *
 * Exits 0 when every audit passes, 1 otherwise.
 */

import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

const audits = Object.keys(pkg.scripts ?? {})
  .filter((name) => name.startsWith("audit:") && name !== "audit:all")
  .sort();

if (audits.length === 0) {
  console.error(
    "audit:all found no audit:* scripts in package.json — refusing to report success for an empty audit suite.",
  );
  process.exit(1);
}

const PAUSE_MS = Number(process.env.AUDIT_PAUSE_MS ?? "2000");
const SERVER_LOG = "/tmp/audit-all-server.log";

let server = null;
function shutdownServer() {
  if (server && server.exitCode === null) server.kill("SIGTERM");
}
process.on("exit", shutdownServer);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shutdownServer();
    process.exit(1);
  });
}

let apiBase = process.env.AUDIT_API_BASE;

if (!apiBase) {
  // Build the CURRENT source so the audits test the code being shipped,
  // not whatever stale build a long-running dev server happens to hold.
  console.log("audit:all — building api-server from current source...");
  const build = spawnSync("pnpm", ["run", "build"], { cwd: pkgDir, stdio: "inherit" });
  if (build.status !== 0) {
    console.error("audit:all: api-server build failed — cannot audit code that does not build.");
    process.exit(1);
  }

  const port = process.env.AUDIT_PORT ?? "8099";
  apiBase = `http://localhost:${port}/api`;
  console.log(`audit:all — booting private API server on port ${port} (log: ${SERVER_LOG})...`);
  const logFd = openSync(SERVER_LOG, "w");
  server = spawn("node", ["--enable-source-maps", "dist/index.mjs"], {
    cwd: pkgDir,
    env: { ...process.env, PORT: port, NODE_ENV: "development" },
    stdio: ["ignore", logFd, logFd],
  });

  // Wait until the server answers HTTP (any status code means it is up).
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      await fetch(`${apiBase}/snowflake/status`);
      up = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!up) {
    console.error(
      `audit:all: private API server did not come up on port ${port} within 60s` +
        `${server.exitCode !== null ? ` (process exited with ${server.exitCode})` : ""}. Last server output:`,
    );
    try {
      console.error(readFileSync(SERVER_LOG, "utf8").split("\n").slice(-20).join("\n"));
    } catch {}
    shutdownServer();
    process.exit(1);
  }
  console.log("audit:all — private API server is up.");
}

console.log(
  `audit:all — running ${audits.length} audit(s) sequentially against ${apiBase}: ${audits.join(", ")}`,
);

const results = [];
for (const [i, name] of audits.entries()) {
  if (i > 0 && PAUSE_MS > 0) {
    // Let the Snowflake proxy's rate-limit window clear between audits.
    await sleep(PAUSE_MS);
  }
  console.log(`\n=== [${i + 1}/${audits.length}] pnpm run ${name} ===`);
  const startedAt = Date.now();
  const { status, error } = spawnSync("pnpm", ["run", name], {
    cwd: pkgDir,
    stdio: "inherit",
    env: { ...process.env, AUDIT_API_BASE: apiBase },
  });
  if (error) console.error(`audit:all could not spawn "pnpm run ${name}": ${error.message}`);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ok = status === 0;
  results.push({ name, ok, status, seconds });
  console.log(
    `=== ${name} ${ok ? "PASSED" : `FAILED (exit ${status ?? "signal"})`} in ${seconds}s ===`,
  );
}

shutdownServer();

console.log("\n──────── audit:all summary ────────");
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.seconds}s)`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(
    `\naudit:all: ${failed.length}/${results.length} audit(s) FAILED: ${failed
      .map((r) => r.name)
      .join(", ")}`,
  );
  process.exit(1);
}
console.log(`\naudit:all: all ${results.length} audit(s) passed.`);
