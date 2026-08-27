/**
 * Cache warm-up effectiveness audit.
 *
 * The startup warm-up (warmDefaultDashboardCaches) only helps if it populates
 * the EXACT cache keys that real default (no-filter) HTTP requests later
 * read. Nothing enforces that at runtime: if a route handler starts injecting
 * an extra filter field, a lib function changes its cache-key shape, or the
 * warm job's filters drift from buildFilters({}), warming keeps "succeeding"
 * while every first visitor silently goes back to 2-4s cold loads.
 *
 * This audit closes that gap end to end, in one process:
 *   1. Runs the REAL production warm-up function (not a reimplementation) on
 *      a cold cache and waits for it to finish.
 *   2. Mounts the REAL dashboards router at the real /api prefix (the router
 *      owns buildFilters and every audited handler; app.ts only adds
 *      logging/cors/body-parsing middlewares, which cannot alter GET query
 *      handling but would drag workspace-TS-only packages into this bundle)
 *      and issues the default HTTP request for every warmed endpoint (paths
 *      from WARMED_ENDPOINTS — the same table the warm-up itself iterates).
 *   3. Observes every cached() access via the cache-observer hook and FAILS
 *      unless each request was served purely from cache hits (zero misses,
 *      zero in-flight joins, at least one hit).
 *
 * NOTE: unlike the other audits, this one deliberately IGNORES AUDIT_API_BASE
 * and always runs in-process against current source. Warm/request cache-key
 * agreement is a property of the code that requires observing the in-process
 * cache right after a controlled warm-up; an external server's warm-up ran at
 * an unknown time (entries go stale after a 5-minute fresh window), so it cannot be audited from
 * outside.
 *
 * Run from artifacts/api-server (needs the same Snowflake env as the server):
 *   pnpm run audit:warmup
 *
 * Exits 0 when every warmed endpoint's default request is a pure cache hit,
 * 1 otherwise.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CacheAccess } from "../src/lib/cache-observer";
import type { WarmedEndpoint, WarmupResult } from "../src/routes/dashboards";

// Must be set BEFORE the app modules are (dynamically) imported below:
// - the audit must warm even when the surrounding env disables warm-up;
// - keep pino-http per-request noise out of the audit output (module-init).
process.env.WARM_DASHBOARD_CACHE = "1";
process.env.LOG_LEVEL ??= "warn";

/**
 * When the first warm cycle has failures, wait this long and run one full
 * second cycle before treating them as real. The Snowflake connector proxy
 * allows ~10 req/s per repl SHARED across concurrent workloads (sibling task
 * validations included), so one-off 429/5xx storms are expected weather;
 * already-warmed keys answer instantly from cache, so the second cycle only
 * re-runs what actually failed. Persistent failures still fail the audit.
 */
const WARM_RETRY_BACKOFF_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same business-day convention the API uses (see todayChicago in routes). */
function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

function truncateKey(key: string, max = 160): string {
  return key.length > max ? `${key.slice(0, max)}…(${key.length} chars)` : key;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Console-backed logger shaped like the pino subset the warm-up expects. */
const warmLogger = {
  info: (obj: unknown, msg?: string) => console.log(`  [warm] ${msg ?? ""} ${JSON.stringify(obj)}`),
  warn: (obj: unknown, msg?: string) => console.warn(`  [warm] WARN ${msg ?? ""} ${JSON.stringify(obj)}`),
};

interface EndpointReport {
  name: string;
  requestPath: string;
  status: number;
  hits: number;
  problems: string[];
}

interface AttemptResult {
  problems: string[];
  dayChanged: boolean;
  warmElapsedMs: number;
}

async function listen(app: import("express").Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

async function runAttempt(
  app: import("express").Express,
  warm: () => Promise<WarmupResult>,
  endpoints: WarmedEndpoint[],
  events: CacheAccess[],
): Promise<AttemptResult> {
  events.length = 0;
  const dayBefore = chicagoToday();
  const problems: string[] = [];

  // ---- Phase 1: the real warm-up, awaited ----
  console.log("Phase 1: running warmDefaultDashboardCaches (real production code path)...");
  let result = await warm();
  if (result.skipped) {
    // The audit forces WARM_DASHBOARD_CACHE=1 above, so this means the
    // enable/disable logic itself changed shape — a warm-up that never runs
    // is exactly the silent uselessness this audit exists to catch.
    return {
      problems: [
        "warm-up reported skipped=true even though WARM_DASHBOARD_CACHE=1 — its enable flag logic changed; warm-up may never run in production",
      ],
      dayChanged: false,
      warmElapsedMs: 0,
    };
  }
  let warmSpanMs = result.elapsedMs;
  if (result.failed.length > 0) {
    // Transient Snowflake weather (e.g. 429 storms on the shared proxy when a
    // sibling audit runs concurrently) can fail a warm job without any key
    // drift existing. Back off and give the REAL warm-up one more full cycle:
    // keys that already warmed hit instantly, only failed ones re-query.
    // Failures that survive both cycles fail the audit below.
    console.log(
      `  warm cycle 1 had failures (${result.failed.join(", ")}) — likely transient; ` +
        `backing off ${WARM_RETRY_BACKOFF_MS / 1000}s and running one full retry cycle...`,
    );
    await sleep(WARM_RETRY_BACKOFF_MS);
    result = await warm();
    warmSpanMs += WARM_RETRY_BACKOFF_MS + result.elapsedMs;
  }
  if (result.failed.length > 0) {
    // Cannot verify hit-ness of endpoints whose warm queries failed — and a
    // persistently failing warm job already means cold first loads in production.
    problems.push(
      `warm-up FAILED for: ${result.failed.join(", ")} across two full warm cycles ` +
        "(each job also retries once per cycle). Their first visitors pay cold loads, and " +
        "this audit cannot verify their cache keys. If Snowflake was flaky, rerun; if it " +
        "persists, the warm jobs are broken.",
    );
  }
  const warmWrites = events.filter((e) => e.outcome === "miss");
  if (warmWrites.length === 0) {
    // Vacuity guard: a cold process that "warms" without a single cache miss
    // means the observer is disconnected or warming no longer touches the
    // shared cached() store — either way this audit would prove nothing.
    problems.push(
      "warm-up produced ZERO cache misses in a cold process — the cache observer is " +
        "disconnected, or warm jobs no longer go through createQueryCache stores " +
        "(src/lib/query-cache.ts emits every request-path access to src/lib/cache-observer.ts). " +
        "The audit cannot see the cache, so it cannot vouch for warm-up.",
    );
  }
  console.log(
    `  warm-up done in ${(result.elapsedMs / 1000).toFixed(1)}s — ` +
      `${result.warmed.length} job(s) ok, ${result.failed.length} failed, ` +
      `${warmWrites.length} cache key(s) populated`,
  );

  // ---- Phase 2: real default HTTP requests through the real app ----
  console.log("Phase 2: issuing default requests against the in-process express app...");
  const server = await listen(app);
  const { port } = server.address() as AddressInfo;
  const reports: EndpointReport[] = [];
  try {
    for (const ep of endpoints) {
      const before = events.length;
      const url = `http://127.0.0.1:${port}${ep.requestPath}`;
      let status = 0;
      try {
        const res = await fetch(url);
        await res.text(); // drain the body
        status = res.status;
      } catch (err) {
        reports.push({
          name: ep.name,
          requestPath: ep.requestPath,
          status: 0,
          hits: 0,
          problems: [`request error: ${err instanceof Error ? err.message : String(err)}`],
        });
        continue;
      }
      const accesses = events.slice(before);
      const misses = accesses.filter((e) => e.outcome !== "hit");
      const hits = accesses.length - misses.length;
      const epProblems: string[] = [];
      if (status !== 200) {
        epProblems.push(`expected HTTP 200, got ${status}`);
      }
      if (accesses.length === 0) {
        epProblems.push(
          "handler performed NO observed cache accesses — its cache store does not report to " +
            "src/lib/cache-observer.ts (call emitCacheAccess in its cached(), like " +
            "overview-targets.ts and leasing.ts do), or the handler stopped caching entirely; " +
            "either way warming this endpoint cannot be verified and may be useless",
        );
      } else if (misses.length > 0) {
        for (const miss of misses) {
          if (warmWrites.some((w) => w.key === miss.key)) {
            // Warm-up attempted this exact key, yet the request missed — the
            // key did not drift. Either the warm query failed (failed entries
            // are not retained) or the entry's TTL expired before we checked.
            epProblems.push(
              result.failed.includes(ep.name)
                ? `cache ${miss.outcome.toUpperCase()} on a key warm-up attempted but FAILED to compute ` +
                    `(failed entries are not retained — fix the failing warm job, this is not key drift)\n` +
                    `        key: ${truncateKey(miss.key)}`
                : `cache ${miss.outcome.toUpperCase()} on a key warm-up populated ${(warmSpanMs / 1000).toFixed(0)}s ago — ` +
                    "the entry was gone when read. Under stale-while-revalidate an aged entry is " +
                    "still served (as a hit), so this means eviction: entry-budget pressure " +
                    "(maxEntries) or age past the keep window — not key drift\n" +
                    `        key: ${truncateKey(miss.key)}`,
            );
            continue;
          }
          // The headline failure: warm-up wrote different keys than the
          // default request reads. Show each missed key next to the
          // closest warm-phase key so the drifted field is obvious.
          const nearest = warmWrites.reduce<{ key: string; shared: number } | null>(
            (best, w) => {
              const shared = commonPrefixLength(w.key, miss.key);
              return shared > (best?.shared ?? 0) ? { key: w.key, shared } : best;
            },
            null,
          );
          epProblems.push(
            `cache ${miss.outcome.toUpperCase()} on a freshly warmed default request\n` +
              `        request read : ${truncateKey(miss.key)}\n` +
              `        warm-up wrote: ${nearest ? truncateKey(nearest.key) : "(nothing remotely similar)"}`,
          );
        }
      }
      reports.push({ name: ep.name, requestPath: ep.requestPath, status, hits, problems: epProblems });
    }
  } finally {
    server.close();
  }

  for (const r of reports) {
    const ok = r.problems.length === 0;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${r.name.padEnd(24)} GET ${r.requestPath} -> ${r.status || "ERR"}; ` +
        `cache hits=${r.hits}${ok ? "" : `; ${r.problems.length} problem(s)`}`,
    );
    for (const p of r.problems) {
      console.error(`      ${r.name}: ${p}`);
      problems.push(`${r.name}: ${p.split("\n")[0]}`);
    }
  }

  return {
    problems,
    dayChanged: chicagoToday() !== dayBefore,
    warmElapsedMs: warmSpanMs,
  };
}
async function main() {
  if (process.env.AUDIT_API_BASE) {
    console.log(
      "note: AUDIT_API_BASE is set but audit:warmup always runs in-process against current " +
        "source — warm/request key agreement cannot be observed from outside a server.",
    );
  }

  // Dynamic imports so the env vars set at the top of this file are in effect
  // when the app modules initialize (the logger reads LOG_LEVEL at init).
  const { default: express } = await import("express");
  const {
    default: dashboardsRouter,
    warmDefaultDashboardCaches,
    WARMED_ENDPOINTS,
  } = await import("../src/routes/dashboards");
  const { setCacheObserver } = await import("../src/lib/cache-observer");

  // Same mount prefix as src/app.ts (app.use("/api", router)), so the
  // requestPath values exercised here are byte-identical to production paths.
  const app = express().use("/api", dashboardsRouter);

  if (WARMED_ENDPOINTS.length === 0) {
    console.error(
      "AUDIT FAILED: WARMED_ENDPOINTS is empty — the warm-up warms nothing, so every " +
        "first visitor after a restart pays cold loads.",
    );
    process.exit(1);
  }
  console.log(
    `Auditing warm-up effectiveness for ${WARMED_ENDPOINTS.length} endpoint(s): ` +
      WARMED_ENDPOINTS.map((e) => e.name).join(", "),
  );

  const events: CacheAccess[] = [];
  setCacheObserver((access) => events.push(access));

  let attempt = await runAttempt(app, () => warmDefaultDashboardCaches(warmLogger), WARMED_ENDPOINTS, events);
  if (attempt.problems.length > 0 && attempt.dayChanged) {
    // The Chicago business day rolled over between warming and requesting, so
    // date-derived cache keys legitimately diverged. One retry lands the whole
    // run inside a single day; a genuine drift will fail again.
    console.log(
      "\nChicago business day changed mid-run (date-derived keys legitimately diverged); " +
        "retrying once inside a single day...",
    );
    attempt = await runAttempt(app, () => warmDefaultDashboardCaches(warmLogger), WARMED_ENDPOINTS, events);
  }
  setCacheObserver(null);

  if (attempt.problems.length > 0) {
    console.error(
      `\nAUDIT FAILED: ${attempt.problems.length} problem(s). The startup warm-up no longer ` +
        "pre-computes what real default requests read — first visitors after a restart are " +
        "paying cold loads. Realign the warm job and the route handler (see WARMED_ENDPOINTS " +
        "in src/routes/dashboards.ts), or fix the failing warm queries.",
    );
    process.exit(1);
  }
  console.log(
    "\nAudit passed: every warmed endpoint's default request was served purely from cache hits.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
