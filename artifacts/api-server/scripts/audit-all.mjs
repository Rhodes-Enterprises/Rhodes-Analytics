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
 * No audit can freeze the pipeline either: each audit process gets a hard
 * time budget (AUDIT_TIMEOUT_MS). An audit still running past its budget
 * has its whole process tree killed and is reported FAILED with a clear
 * "timed out" message, and the remaining audits still run.
 *
 * Run from artifacts/api-server:
 *   pnpm run audit:all
 *
 * Env:
 *   AUDIT_API_BASE  audit this base URL instead of booting a private server
 *   AUDIT_PORT      port for the private server (default 8099)
 *   AUDIT_PAUSE_MS  pause between consecutive audits so the proxy's
 *                   rate-limit window clears (default 2000)
 *   AUDIT_TIMEOUT_MS  per-audit time budget in ms; an audit still running
 *                   after this long is killed (whole process tree) and
 *                   reported FAILED as timed out, without blocking the
 *                   remaining audits (default 900000 = 15 min; 0 disables)
 *   AUDIT_FETCH_TIMEOUT_MS  per-request deadline inside the audits' shared
 *                   API fetch helper (scripts/lib/fetch-retry.ts, default
 *                   120000); a timed-out request retries like any transient
 *                   network error, so a hung endpoint fails its audit fast
 *   (plus everything the individual audits honor: AUDIT_TOLERANCE_PCT, ...)
 *
 * Exits 0 when every audit passes, 1 otherwise.
 */

import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { resolveBudgetMs } from "./lib/timeout-config.mjs";

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
// Per-audit time budget. audit:all gates task completion, so one stuck audit
// (hung endpoint, stalled connection, wedged child process) must fail fast
// with a clear message instead of silently freezing the whole pipeline. The
// default is deliberately generous — the audits' own per-request deadline +
// bounded retries (see scripts/lib/fetch-retry.ts) resolve a hung endpoint
// in ≈12.5 min worst case, so only a truly wedged audit ever hits this.
// Explicit AUDIT_TIMEOUT_MS=0 disables the budget (debugging escape hatch).
const DEFAULT_AUDIT_TIMEOUT_MS = 900_000;
const AUDIT_TIMEOUT_MS = resolveBudgetMs(process.env.AUDIT_TIMEOUT_MS, DEFAULT_AUDIT_TIMEOUT_MS);

// Regression guard for the watchdog config: Number("") is 0, so a naive
// parse once turned "env unset" into "budget disabled" and no timer was ever
// armed. audit:all is the shipping gate — its own safety config must not rot
// silently, so prove the resolver's contract on every run (costs nothing).
for (const [raw, want] of [
  [undefined, DEFAULT_AUDIT_TIMEOUT_MS], // unset → default, NOT disabled
  ["", DEFAULT_AUDIT_TIMEOUT_MS],
  ["not-a-number", DEFAULT_AUDIT_TIMEOUT_MS],
  ["-5", DEFAULT_AUDIT_TIMEOUT_MS],
  ["0", 0], // only an EXPLICIT 0 disables the budget
  ["600000", 600_000],
]) {
  const got = resolveBudgetMs(raw, DEFAULT_AUDIT_TIMEOUT_MS);
  if (got !== want) {
    console.error(
      `audit:all: resolveBudgetMs(${raw === undefined ? "undefined" : JSON.stringify(raw)}) ` +
        `returned ${got}, expected ${want} — refusing to run with a broken timeout config.`,
    );
    process.exit(1);
  }
}
const SERVER_LOG = "/tmp/audit-all-server.log";

// The Snowflake connector proxy allows ~10 req/s for the WHOLE repl, and an
// audit run drives it from TWO processes at once: the private API server
// (cold-cache loader fan-out — a single leasing load fires 14 queries — plus
// statement polling) and the audit script itself (baseline queries + polling).
// The shared transport paces each process (src/lib/snowflake.ts), but two
// processes at the default ~5 req/s still sum to the entire repl budget and
// sustained 429 storms can outlast the audits' bounded retries. Audit runs
// are batch work, so run BOTH processes at roughly half pace instead — the
// pair then fits the budget with headroom for the dev server. Explicit env
// wins so the knobs stay tunable per run.
const AUDIT_SNOWFLAKE_PACING = {
  SNOWFLAKE_MIN_START_SPACING_MS: process.env.SNOWFLAKE_MIN_START_SPACING_MS ?? "450",
  SNOWFLAKE_MAX_IN_FLIGHT: process.env.SNOWFLAKE_MAX_IN_FLIGHT ?? "3",
};

let server = null;
let currentAudit = null;

/**
 * Kill an audit and everything it spawned. Each audit runs `detached` as its
 * own process-group leader, so signaling the NEGATIVE pid reaches the whole
 * tree (pnpm → shell → node → esbuild/chromium). Killing only the direct
 * pnpm child would orphan the actual audit process, which would keep running
 * and keep hammering the shared API server underneath the remaining audits.
 */
function killAuditTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function shutdownServer() {
  if (server && server.exitCode === null) server.kill("SIGTERM");
}
process.on("exit", shutdownServer);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (currentAudit) killAuditTree(currentAudit);
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
    // WARM_DASHBOARD_CACHE=0: the boot-time cache warm-up fires the same
    // Snowflake queries the audits are about to fire, and together they
    // burst past the connector proxy's ~10 req/s limit — the first audit
    // then sees 429-exhausted 502s from a server that is healthy in normal
    // use. A throwaway audit server also gains nothing from warm caches:
    // the warmed entries would all turn stale five minutes later — mid-
    // suite — and their background refresh waves starve the audits' own
    // baseline queries. Each audit's first fetch warms exactly what it
    // checks, so keep boot quiet.
    env: {
      ...process.env,
      ...AUDIT_SNOWFLAKE_PACING,
      PORT: port,
      NODE_ENV: "development",
      WARM_DASHBOARD_CACHE: "0",
    },
    stdio: ["ignore", logFd, logFd],
  });

  // Wait until the server answers HTTP (any status code means it is up).
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      // Cap each probe so one wedged socket cannot eat the 60s boot deadline.
      await fetch(`${apiBase}/snowflake/status`, { signal: AbortSignal.timeout(2000) });
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
console.log(
  `audit:all — per-audit budget: ${
    AUDIT_TIMEOUT_MS > 0 ? `${AUDIT_TIMEOUT_MS}ms` : "DISABLED (AUDIT_TIMEOUT_MS=0)"
  }`,
);

/**
 * Run one audit with a hard time budget. Async spawn instead of spawnSync's
 * own `timeout` option, because spawnSync can only signal the direct pnpm
 * child — which would orphan the real audit process underneath it — while a
 * detached child gives killAuditTree a process group to reap in one shot.
 */
function runAudit(name) {
  return new Promise((resolvePromise) => {
    const child = spawn("pnpm", ["run", name], {
      cwd: pkgDir,
      stdio: "inherit",
      env: { ...process.env, ...AUDIT_SNOWFLAKE_PACING, AUDIT_API_BASE: apiBase },
      detached: true, // own process group → a timeout kill reaps ALL descendants
    });
    currentAudit = child;
    let settled = false;
    let timedOut = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (currentAudit === child) currentAudit = null;
      resolvePromise(result);
    };
    const timer =
      AUDIT_TIMEOUT_MS > 0
        ? setTimeout(() => {
            if (settled) return;
            timedOut = true;
            console.error(
              `\naudit:all: "${name}" is still running after its ${AUDIT_TIMEOUT_MS}ms budget — ` +
                `killing its process tree. Raise AUDIT_TIMEOUT_MS if this audit legitimately needs longer.`,
            );
            killAuditTree(child);
          }, AUDIT_TIMEOUT_MS)
        : null;
    child.once("error", (error) => settle({ status: null, signal: null, timedOut, error }));
    child.once("exit", (status, signal) => settle({ status, signal, timedOut, error: null }));
  });
}

const results = [];
for (const [i, name] of audits.entries()) {
  if (i > 0 && PAUSE_MS > 0) {
    // Let the Snowflake proxy's rate-limit window clear between audits.
    await sleep(PAUSE_MS);
  }
  console.log(`\n=== [${i + 1}/${audits.length}] pnpm run ${name} ===`);
  const startedAt = Date.now();
  const { status, signal, timedOut, error } = await runAudit(name);
  if (error) console.error(`audit:all could not spawn "pnpm run ${name}": ${error.message}`);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ok = status === 0 && !timedOut;
  results.push({ name, ok, timedOut, status, seconds });
  console.log(
    `=== ${name} ${
      ok
        ? "PASSED"
        : timedOut
          ? `FAILED (TIMED OUT: no result within AUDIT_TIMEOUT_MS=${AUDIT_TIMEOUT_MS}ms; process tree killed)`
          : `FAILED (exit ${status ?? `signal ${signal ?? "unknown"}`})`
    } in ${seconds}s ===`,
  );
}

shutdownServer();

console.log("\n──────── audit:all summary ────────");
for (const r of results) {
  console.log(
    `  ${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.seconds}s${r.timedOut ? ", TIMED OUT" : ""})`,
  );
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(
    `\naudit:all: ${failed.length}/${results.length} audit(s) FAILED: ${failed
      .map((r) => (r.timedOut ? `${r.name} (timed out)` : r.name))
      .join(", ")}`,
  );
  process.exit(1);
}
console.log(`\naudit:all: all ${results.length} audit(s) passed.`);
