#!/usr/bin/env node
/**
 * Mutation test for the dashboard audit suite: prove the batched baseline
 * checks in audit-dashboard.ts, audit-leasing.ts, and audit-yoy.ts still
 * FAIL LOUDLY when a number is wrong.
 *
 * Those audits' baselines were consolidated from many one-count Snowflake
 * queries into few grouped / conditional-aggregation queries (COUNT_IF flag
 * subqueries, GROUP BY month/type, UNION ALL legs, JS rollups). They pass
 * against real data — but a check that PASSES proves little unless it can
 * also FAIL. This harness runs each REAL audit script, unmodified, through
 * a tiny local proxy that forwards to a real API server and doctors ONE
 * response per targeted check (inflating a single value), then asserts:
 *
 *   1. the audit exits 1 (a doctored run that passes means a check cannot
 *      fail — exactly the gap this harness exists to catch),
 *   2. every expected "FAIL <check>" line for the doctored values appears,
 *   3. every planned doctoring actually fired (a mutation that never
 *      matched a request means the audit stopped exercising that view),
 *   4. NO OTHER check failed — the failure is precisely the doctored one,
 *      so the run also demonstrates the checks are independent. (An
 *      unrelated FAIL line usually means real divergence or transient
 *      mid-day data movement — rerun, and investigate if it persists.)
 *
 * One doctored value per batched-baseline shape, at least one per script:
 *
 *   audit:dashboard (default view of /dashboards/overview-with-targets)
 *     - trafficMatrix.total.tours.actual  → headline COUNT_IF flag-subquery
 *       scan (bind-order-sensitive: subquery SELECT-list window binds
 *       precede WHERE fragment binds). Also deterministically trips the
 *       divisions/developments sum-vs-headline consistency nets.
 *     - the busiest division row's leads  → per-company JS rollup of the
 *       per-development grouped scan (plus the divisions sum net).
 *     - kpis.salesGoal                    → grouped goal sum
 *       (SUM(GOAL) GROUP BY GOAL_TYPE).
 *
 *   audit:yoy (default view of /dashboards/overview-with-targets/yoy)
 *     - the leads point of the last checked month (current year)
 *       → per-measure GROUP BY (year, month) baseline.
 *     - the grossSales goal point of the first checked month
 *       → goal GROUP BY (goal type, month) baseline.
 *
 *   audit:leasing (default view of /dashboards/leasing)
 *     - kpis.leasesRatified   → headline COUNT_IF window scan (subquery
 *       SELECT-list binds precede WHERE binds).
 *     - monthly[1].ratified   → the RAT leg of the UNION ALL monthly query.
 *     - monthly[2].cancelled  → the CAN leg of the UNION ALL monthly query.
 *     - kpis.leaseGoal        → grouped goal sum (baselineGoalsByType).
 *
 * Doctoring: value → value * 2 + 1000. That diverges far beyond the audits'
 * tolerance whether the true value is 0 (0 vs 1000 trips the zero-vs-nonzero
 * branch) or large, without ever producing a same-side-zero comparison the
 * checks would skip.
 *
 * Self-contained like audit:all: builds the api-server and boots a private
 * copy (default port 8123) unless AUDIT_API_BASE points at a running server.
 * The audits themselves are pointed at the doctoring proxy via their own
 * AUDIT_API_BASE env — no audit or server code is modified, weakened, or
 * skipped.
 *
 * Deliberately NOT named `audit:*`: audit:all auto-discovers that namespace,
 * and this harness re-runs three full audits (double Snowflake load) and
 * would not fit inside audit:all's per-audit time budget. Run it on demand
 * after changing any audit's baseline queries or check wiring:
 *
 *   pnpm --filter @workspace/api-server run audit-mutation
 *
 * Env:
 *   AUDIT_API_BASE            doctor an already-running server instead of
 *                             booting a private one (e.g. http://localhost:8080/api)
 *   AUDIT_MUTATION_PORT       port for the private server (default 8123 —
 *                             distinct from audit:all's 8099 so both can run)
 *   AUDIT_MUTATION_ONLY       comma list to run a subset: dashboard,yoy,leasing
 *   AUDIT_MUTATION_TIMEOUT_MS per-audit budget (default 900000; explicit 0
 *                             disables; must exceed the audits' own retry
 *                             chain ≈12.5 min — see scripts/lib/fetch-retry.ts)
 *   AUDIT_PAUSE_MS            pause between audits so the Snowflake proxy's
 *                             rate-limit window clears (default 2000)
 *
 * Exits 0 when every audit failed EXACTLY as doctored; 1 on any deviation
 * (an audit that passed, a missing expected FAIL, an unfired mutation, an
 * unexpected FAIL, a timeout, or a build/boot problem).
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { resolveBudgetMs } from "./lib/timeout-config.mjs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- Same business-day / checked-month conventions the audits use ----------

function todayChicago() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

/** Mirrors monthsToCheck() in audit-yoy.ts (3 most recent fully-elapsed months). */
function yoyMonthsToCheck() {
  const currentMonth = Number(todayChicago().slice(5, 7));
  const lastFull = currentMonth - 1;
  if (lastFull < 1) return [1];
  const start = Math.max(1, lastFull - 2);
  return Array.from({ length: lastFull - start + 1 }, (_, i) => start + i);
}

const YEAR = Number(todayChicago().slice(0, 4));
const YOY_MONTHS = yoyMonthsToCheck();
const mm = (m) => String(m).padStart(2, "0");

/**
 * value → value * 2 + 1000: guaranteed far beyond the audits' 0.5% relative
 * tolerance, and never turns a comparison into skippable 0-vs-0 (a true 0
 * becomes 1000, tripping the zero-baseline Infinity branch instead).
 */
const perturb = (n) => n * 2 + 1000;

// ---------- Mutation plan ----------
// Each mutation doctors ONE value in ONE endpoint response (matched by exact
// pathname + exact query string — "" means the default, parameterless view).
// `expect` regexes must ALL appear in the audit output; `alsoAllowed` lines
// are legitimate knock-on failures of the same doctored value (e.g. a PTG
// derived from the doctored actual) that may or may not trip depending on
// live data, and anything else that FAILs is reported as unexpected.

const RUNS = [
  {
    key: "dashboard",
    script: "audit:dashboard",
    mutations: [
      {
        id: "headline-count_if(tours)",
        kind: "headline COUNT_IF flag-subquery scan",
        path: "/api/dashboards/overview-with-targets",
        query: "",
        apply(body) {
          const cell = body?.trafficMatrix?.total?.tours;
          if (typeof cell?.actual !== "number") return null;
          const was = cell.actual;
          cell.actual = perturb(was);
          return `trafficMatrix.total.tours.actual ${was} -> ${cell.actual}`;
        },
        expect: [
          /^FAIL tours\s+api=/m,
          // The doctored headline also breaks the rows+unattributed==headline nets.
          /^FAIL sum\s+tours\s+divisions\b/m,
          /^FAIL sum\s+tours\s+developments\b/m,
        ],
        // PTG is derived from the doctored actual; trips only when the cell
        // has a non-zero to-date goal (otherwise both sides are null).
        alsoAllowed: [/^FAIL goal ptg\s+total\.tours\b/m],
      },
      {
        id: "js-company-rollup(division leads)",
        kind: "per-company JS rollup of the per-development grouped scan",
        path: "/api/dashboards/overview-with-targets",
        query: "",
        apply(body) {
          const rows = Array.isArray(body?.divisions) ? body.divisions : [];
          let best = null;
          for (const r of rows) {
            if (typeof r?.leads === "number" && (best === null || r.leads > best.leads)) best = r;
          }
          if (!best) return null;
          const was = best.leads;
          best.leads = perturb(was);
          return `divisions[${JSON.stringify(best.division)}].leads ${was} -> ${best.leads}`;
        },
        expect: [/^FAIL division leads\s+\S/m, /^FAIL sum\s+leads\s+divisions\b/m],
      },
      {
        id: "grouped-goal-sum(kpis.salesGoal)",
        kind: "grouped goal sum (SUM(GOAL) GROUP BY GOAL_TYPE)",
        path: "/api/dashboards/overview-with-targets",
        query: "",
        apply(body) {
          if (typeof body?.kpis?.salesGoal !== "number") return null;
          const was = body.kpis.salesGoal;
          body.kpis.salesGoal = perturb(was);
          return `kpis.salesGoal ${was} -> ${body.kpis.salesGoal}`;
        },
        expect: [/^FAIL goal fullSpan kpi\.grossSales\b/m],
      },
    ],
  },
  {
    key: "yoy",
    script: "audit:yoy",
    mutations: [
      {
        id: `grouped-month(leads ${YEAR}-${mm(YOY_MONTHS.at(-1))})`,
        kind: "per-measure GROUP BY (year, month) baseline",
        path: "/api/dashboards/overview-with-targets/yoy",
        query: "",
        apply(body) {
          const m = (body?.measures ?? []).find((x) => x?.measure === "leads");
          const pt = m?.points?.find((p) => p?.month === YOY_MONTHS.at(-1));
          if (!pt || typeof pt.currentYear !== "number") return null;
          const was = pt.currentYear;
          pt.currentYear = perturb(was);
          return `measures[leads].points[month=${pt.month}].currentYear ${was} -> ${pt.currentYear}`;
        },
        expect: [new RegExp(`^FAIL leads ${YEAR}-${mm(YOY_MONTHS.at(-1))}\\s+api=`, "m")],
      },
      {
        id: `grouped-goal(grossSales goal ${YEAR}-${mm(YOY_MONTHS[0])})`,
        kind: "goal GROUP BY (goal type, month) baseline",
        path: "/api/dashboards/overview-with-targets/yoy",
        query: "",
        apply(body) {
          const m = (body?.measures ?? []).find((x) => x?.measure === "grossSales");
          const pt = m?.points?.find((p) => p?.month === YOY_MONTHS[0]);
          if (!pt || typeof pt.goal !== "number") return null;
          const was = pt.goal;
          pt.goal = perturb(was);
          return `measures[grossSales].points[month=${pt.month}].goal ${was} -> ${pt.goal}`;
        },
        expect: [new RegExp(`^FAIL grossSales goal ${YEAR}-${mm(YOY_MONTHS[0])}\\s+api=`, "m")],
      },
    ],
  },
  {
    key: "leasing",
    script: "audit:leasing",
    mutations: [
      {
        id: "headline-count_if(kpis.leasesRatified)",
        kind: "headline COUNT_IF window scan",
        path: "/api/dashboards/leasing",
        query: "",
        apply(body) {
          if (typeof body?.kpis?.leasesRatified !== "number") return null;
          const was = body.kpis.leasesRatified;
          body.kpis.leasesRatified = perturb(was);
          return `kpis.leasesRatified ${was} -> ${body.kpis.leasesRatified}`;
        },
        expect: [/^[ \t]*FAIL kpis\.leasesRatified:/m],
      },
      {
        id: "union-all-RAT-leg(monthly[1].ratified)",
        kind: "UNION ALL monthly query, LEASE_RATIFIED_DATE leg",
        path: "/api/dashboards/leasing",
        query: "",
        apply(body) {
          const pt = (body?.monthly ?? []).find((p) => p?.month === 1);
          if (!pt || typeof pt.ratified !== "number") return null;
          const was = pt.ratified;
          pt.ratified = perturb(was);
          return `monthly[1].ratified ${was} -> ${pt.ratified}`;
        },
        expect: [/^[ \t]*FAIL monthly\[1\]\.ratified:/m],
      },
      {
        id: "union-all-CAN-leg(monthly[2].cancelled)",
        kind: "UNION ALL monthly query, CANCELLATION_DATE leg",
        path: "/api/dashboards/leasing",
        query: "",
        apply(body) {
          const pt = (body?.monthly ?? []).find((p) => p?.month === 2);
          if (!pt || typeof pt.cancelled !== "number") return null;
          const was = pt.cancelled;
          pt.cancelled = perturb(was);
          return `monthly[2].cancelled ${was} -> ${pt.cancelled}`;
        },
        expect: [/^[ \t]*FAIL monthly\[2\]\.cancelled:/m],
      },
      {
        id: "grouped-goal-sum(kpis.leaseGoal)",
        kind: "grouped goal sum (baselineRlGoalSums grouped query + JS rollup)",
        path: "/api/dashboards/leasing",
        query: "",
        apply(body) {
          if (typeof body?.kpis?.leaseGoal !== "number") return null;
          const was = body.kpis.leaseGoal;
          body.kpis.leaseGoal = perturb(was);
          return `kpis.leaseGoal ${was} -> ${body.kpis.leaseGoal}`;
        },
        expect: [/^[ \t]*FAIL kpis\.leaseGoal:/m],
      },
    ],
  },
];

// Every audit ends a failing run with its own "AUDIT FAILED: ..." summary —
// expected here, never "unexpected".
const SUMMARY_LINES = [/^AUDIT FAILED:/];

// ---------- Config ----------

const PAUSE_MS = Number(process.env.AUDIT_PAUSE_MS ?? "2000");
const DEFAULT_TIMEOUT_MS = 900_000;
const TIMEOUT_MS = resolveBudgetMs(process.env.AUDIT_MUTATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
// The proxy's upstream deadline must exceed the audits' own per-request
// deadline (fetch-retry.ts), so the proxy is never the binding timeout.
const rawFetchTimeout = Number(process.env.AUDIT_FETCH_TIMEOUT_MS ?? "");
const UPSTREAM_DEADLINE_MS =
  (Number.isFinite(rawFetchTimeout) && rawFetchTimeout > 0 ? rawFetchTimeout : 120_000) + 60_000;

const only = (process.env.AUDIT_MUTATION_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const runs = only.length ? RUNS.filter((r) => only.includes(r.key)) : RUNS;
if (runs.length === 0) {
  console.error(
    `audit-mutation: AUDIT_MUTATION_ONLY=${JSON.stringify(process.env.AUDIT_MUTATION_ONLY)} ` +
      `matches none of: ${RUNS.map((r) => r.key).join(", ")}`,
  );
  process.exit(1);
}

const SERVER_LOG = "/tmp/audit-mutation-server.log";

let server = null;
let currentAudit = null;
let proxy = null;

/** Kill an audit and everything it spawned (see audit-all.mjs for rationale). */
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

function shutdown() {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (proxy) proxy.close();
}
process.on("exit", shutdown);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (currentAudit) killAuditTree(currentAudit);
    shutdown();
    process.exit(1);
  });
}

// ---------- Upstream API server (private copy unless AUDIT_API_BASE) ----------

// Same rationale as audit-all.mjs: the connector proxy allows ~10 req/s for
// the WHOLE repl, and a mutation run drives it from two processes at once
// (the private server's cold-cache fan-out plus the audit's baselines).
// Each process's shared transport defaults to ~5 req/s, which sums to the
// entire budget — sustained 429 storms then outlast the audits' bounded
// retries and crash a run that only overlapped with the dev server or a
// sibling process. Run both processes at roughly half pace; explicit env
// wins so the knobs stay tunable per run.
const AUDIT_SNOWFLAKE_PACING = {
  SNOWFLAKE_MIN_START_SPACING_MS: process.env.SNOWFLAKE_MIN_START_SPACING_MS ?? "450",
  SNOWFLAKE_MAX_IN_FLIGHT: process.env.SNOWFLAKE_MAX_IN_FLIGHT ?? "3",
};

let upstreamApiBase = process.env.AUDIT_API_BASE;

if (!upstreamApiBase) {
  console.log("audit-mutation — building api-server from current source...");
  const build = spawnSync("pnpm", ["run", "build"], { cwd: pkgDir, stdio: "inherit" });
  if (build.status !== 0) {
    console.error("audit-mutation: api-server build failed — cannot audit code that does not build.");
    process.exit(1);
  }

  const port = process.env.AUDIT_MUTATION_PORT ?? "8123";
  upstreamApiBase = `http://localhost:${port}/api`;
  console.log(`audit-mutation — booting private API server on port ${port} (log: ${SERVER_LOG})...`);
  const logFd = openSync(SERVER_LOG, "w");
  server = spawn("node", ["--enable-source-maps", "dist/index.mjs"], {
    cwd: pkgDir,
    // WARM_DASHBOARD_CACHE=0 for the same reason as audit:all: the warm-up
    // burst plus the audits would trip the Snowflake proxy's ~10 RPS limit.
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: "development",
      WARM_DASHBOARD_CACHE: "0",
      ...AUDIT_SNOWFLAKE_PACING,
    },
    stdio: ["ignore", logFd, logFd],
  });

  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      await fetch(`${upstreamApiBase}/snowflake/status`, { signal: AbortSignal.timeout(2000) });
      up = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!up) {
    console.error(
      `audit-mutation: private API server did not come up on port ${port} within 60s` +
        `${server.exitCode !== null ? ` (process exited with ${server.exitCode})` : ""}. Last server output:`,
    );
    try {
      console.error(readFileSync(SERVER_LOG, "utf8").split("\n").slice(-20).join("\n"));
    } catch {}
    shutdown();
    process.exit(1);
  }
  console.log("audit-mutation — private API server is up.");
}

// ---------- Doctoring proxy ----------

// The active run's mutations; swapped per audit run. Requests that match no
// mutation pass through byte-for-byte.
const active = { mutations: [] };

proxy = createServer(async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("audit-mutation proxy only forwards GET requests");
      return;
    }
    const u = new URL(req.url, "http://localhost");
    if (u.pathname !== "/api" && !u.pathname.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("audit-mutation proxy expects /api/... paths");
      return;
    }
    const upstreamUrl =
      upstreamApiBase.replace(/\/+$/, "") + u.pathname.slice("/api".length) + u.search;
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        signal: AbortSignal.timeout(UPSTREAM_DEADLINE_MS),
        headers: { accept: req.headers.accept ?? "*/*" },
      });
    } catch (err) {
      // Surface as a 502 — the audits' fetch helper treats it as transient
      // and retries, exactly like any other upstream hiccup.
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`audit-mutation proxy: upstream fetch failed: ${err?.message ?? err}`);
      return;
    }
    const raw = Buffer.from(await upstream.arrayBuffer());
    const search = u.search.startsWith("?") ? u.search.slice(1) : u.search;
    const matching = active.mutations.filter((m) => m.path === u.pathname && m.query === search);
    let body = raw;
    if (matching.length > 0 && upstream.ok) {
      let json;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        json = undefined; // non-JSON: pass through; the unfired-mutation check reports it
      }
      if (json !== undefined) {
        for (const m of matching) {
          const desc = m.apply(json);
          if (desc === null) {
            m.targetMissing = true;
            console.error(`[proxy] ${m.id}: target field missing in ${u.pathname} response`);
          } else {
            m.fired += 1;
            console.log(`[proxy] doctored ${u.pathname}: ${desc}  (${m.id})`);
          }
        }
        body = Buffer.from(JSON.stringify(json));
      }
    }
    // fetch() already decoded any content-encoding; send plain bytes with a
    // fresh length and the upstream's content type.
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "content-length": body.length,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`audit-mutation proxy error: ${err?.message ?? err}`);
  }
});

const proxyPort = await new Promise((resolvePort, rejectPort) => {
  proxy.once("error", rejectPort);
  proxy.listen(0, "127.0.0.1", () => resolvePort(proxy.address().port));
});
const proxyApiBase = `http://127.0.0.1:${proxyPort}/api`;
console.log(
  `audit-mutation — doctoring proxy on ${proxyApiBase} → ${upstreamApiBase}; ` +
    `per-audit budget: ${TIMEOUT_MS > 0 ? `${TIMEOUT_MS}ms` : "DISABLED"}`,
);

// ---------- Run one audit through the proxy ----------

function spawnAudit(script, logPath) {
  return new Promise((resolvePromise) => {
    const out = createWriteStream(logPath);
    const child = spawn("pnpm", ["run", script], {
      cwd: pkgDir,
      env: { ...process.env, AUDIT_API_BASE: proxyApiBase, ...AUDIT_SNOWFLAKE_PACING },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group → a timeout kill reaps ALL descendants
    });
    currentAudit = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      out.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      out.write(d);
    });
    let settled = false;
    let timedOut = false;
    const settle = (status, signal, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (currentAudit === child) currentAudit = null;
      out.end();
      resolvePromise({ status, signal, timedOut, error, stdout, stderr });
    };
    const timer =
      TIMEOUT_MS > 0
        ? setTimeout(() => {
            if (settled) return;
            timedOut = true;
            console.error(
              `audit-mutation: "${script}" still running after ${TIMEOUT_MS}ms — killing its process tree.`,
            );
            killAuditTree(child);
          }, TIMEOUT_MS)
        : null;
    child.once("error", (error) => settle(null, null, error));
    child.once("exit", (status, signal) => settle(status, signal, null));
  });
}

/** Lines that begin (after indentation) with "FAIL " — the audits' failing checks. */
function failLines(text) {
  return text.split("\n").filter((line) => /^[ \t]*FAIL /.test(line));
}

const results = [];

for (const [i, run] of runs.entries()) {
  if (i > 0 && PAUSE_MS > 0) await sleep(PAUSE_MS);

  console.log(`\n=== [${i + 1}/${runs.length}] ${run.script} with doctored responses ===`);
  for (const m of run.mutations) {
    m.fired = 0;
    m.targetMissing = false;
    console.log(`  will doctor: ${m.id} — ${m.kind}`);
  }
  active.mutations = run.mutations;
  const logPath = `/tmp/audit-mutation-${run.key}.log`;
  const startedAt = Date.now();
  const r = await spawnAudit(run.script, logPath);
  active.mutations = [];
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  const output = r.stdout + "\n" + r.stderr;
  const problems = [];
  const evidence = [];

  if (r.error) problems.push(`could not spawn "pnpm run ${run.script}": ${r.error.message}`);
  if (r.timedOut) problems.push(`timed out after ${TIMEOUT_MS}ms (process tree killed)`);

  for (const m of run.mutations) {
    if (m.targetMissing) {
      problems.push(
        `${m.id}: response no longer carries the doctored field — the endpoint shape ` +
          `changed; update this harness's mutation to keep the check covered`,
      );
    } else if (m.fired === 0) {
      problems.push(
        `${m.id}: mutation never fired — the audit no longer requests ` +
          `${m.path}${m.query ? `?${m.query}` : ""} (default view), so this check went unexercised`,
      );
    }
  }

  if (!r.timedOut && !r.error) {
    if (r.status === 0) {
      problems.push(
        `audit PASSED (exit 0) despite doctored response values — at least one of the ` +
          `targeted checks CANNOT FAIL; that check is broken (vacuous), fix the audit`,
      );
    } else if (r.status !== 1) {
      problems.push(
        `audit exited ${r.status ?? `signal ${r.signal}`} — expected a clean check-failure ` +
          `exit 1, not a crash (see ${logPath})`,
      );
    }
    // Exit 1 alone is NOT proof: a crash also exits 1. Demand the audit's own
    // end-of-run accounting (its "AUDIT FAILED:" summary only prints after
    // every scenario ran), and reject crash markers outright.
    if (/^AUDIT ERRORED:/m.test(output)) {
      problems.push(
        `audit CRASHED (AUDIT ERRORED) instead of completing its checks — a crash is not ` +
          `a demonstrated check failure; fix the audit (see ${logPath})`,
      );
    } else if (r.status === 1 && !/^AUDIT FAILED:/m.test(output)) {
      problems.push(
        `audit exited 1 without printing its final "AUDIT FAILED:" summary — it died ` +
          `before finishing all scenarios (see ${logPath})`,
      );
    }
  }

  const allowed = [...SUMMARY_LINES];
  for (const m of run.mutations) {
    allowed.push(...m.expect, ...(m.alsoAllowed ?? []));
    for (const rx of m.expect) {
      const match = output.match(rx);
      if (!match) {
        problems.push(`${m.id}: expected failing check ${rx} never appeared in the output`);
      } else {
        const line = output.slice(match.index).split("\n", 1)[0];
        evidence.push(line.trim());
      }
    }
  }

  // Scan stdout and stderr separately so interleaved chunks cannot corrupt
  // line boundaries within either stream.
  const unexpected = [...failLines(r.stdout), ...failLines(r.stderr)].filter(
    (line) => !allowed.some((rx) => rx.test(line)),
  );
  if (unexpected.length > 0) {
    problems.push(
      `unexpected FAIL line(s) — not caused by the doctored values (real divergence or ` +
        `transient mid-day data movement; rerun, investigate if it persists):\n` +
        unexpected.map((l) => `      ${l.trim()}`).join("\n"),
    );
  }

  const ok = problems.length === 0;
  results.push({ run, ok, problems, evidence, seconds, logPath });
  console.log(
    `=== ${run.script} ${ok ? "failed exactly as doctored ✔" : "DID NOT behave as expected ✘"} in ${seconds}s (full log: ${logPath}) ===`,
  );
  for (const line of evidence) console.log(`    tripped: ${line}`);
  for (const p of problems) console.error(`    PROBLEM: ${p}`);
  if (!ok) {
    const tail = output.split("\n").slice(-25).join("\n");
    console.error(`    ── last 25 output lines ──\n${tail}`);
  }
}

shutdown();

console.log("\n──────── audit mutation-test summary ────────");
for (const r of results) {
  console.log(
    `  ${r.ok ? "PASS" : "FAIL"}  ${r.run.script}  (${r.run.mutations.length} doctored value(s), ` +
      `${r.evidence.length} expected FAIL line(s) observed, ${r.seconds}s)`,
  );
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(
    `\naudit-mutation: ${failed.length}/${results.length} audit(s) did NOT fail the way the ` +
      `doctored values demanded — see PROBLEM lines above. A doctored run that passes or ` +
      `mis-fails means a check has gone vacuous or a response shape drifted; fix the audit ` +
      `(or this harness's mutation specs) before trusting the suite.`,
  );
  process.exit(1);
}
console.log(
  `\naudit-mutation: all ${results.length} audit(s) failed loudly and precisely on the doctored ` +
    `values — the batched baseline checks still catch wrong numbers.`,
);
process.exit(0);
