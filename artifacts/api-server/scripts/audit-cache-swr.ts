/**
 * Cache behavior audit (`pnpm run audit:cache-swr`).
 *
 * Verifies the stale-while-revalidate contract of lib/query-cache.ts that
 * keeps dashboards loading instantly all day:
 *
 *  1. cold misses are single-flight (concurrent callers share one query)
 *  2. fresh hits never re-query
 *  3. stale hits return IMMEDIATELY (no waiting on Snowflake) and trigger
 *     exactly one background refresh — refreshes are traffic-driven only,
 *     never timer-driven, so an idle dashboard lets the warehouse suspend
 *  4. background refreshes are capped at 2 concurrent process-wide so a
 *     stale dashboard fan-out cannot burst past the connector proxy's
 *     ~10 req/s per-repl rate limit
 *  5. entries past the keep window block on a foreground reload (no
 *     unboundedly old data)
 *  6. a failed refresh keeps serving the stale value and backs off instead
 *     of hammering a failing upstream
 *  7. the entry-count bound still evicts oldest-first
 *
 * Pure in-memory test with injected fake loaders — no Snowflake traffic, no
 * API server needed (AUDIT_API_BASE is ignored). Runs in ~10 seconds.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import { createQueryCache } from "../src/lib/query-cache";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`OK   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`, detail ?? "");
  }
}

// Generous timing margins: a "blocking" load takes LOAD_MS (>=250ms), while
// an "instant" cache serve must stay under INSTANT_MS (100ms) — far enough
// apart that scheduler jitter cannot flip a result either way.
const LOAD_MS = 250;
const INSTANT_MS = 100;

async function testSwrLifecycle() {
  // Margins: every boundary the assertions depend on is >=250ms away from
  // the nearest sleep target, so scheduler jitter cannot flip a result.
  const FRESH = 800;
  const cached = createQueryCache({ maxEntries: 10, freshMs: FRESH, keepMs: 60_000 });
  let calls = 0;
  const fn = async () => {
    calls++;
    await sleep(LOAD_MS);
    return `v${calls}`;
  };

  // 1. cold miss: single-flight
  const [a, b] = await Promise.all([cached("k", fn), cached("k", fn)]);
  check("miss: concurrent callers share one query", calls === 1, calls);
  check("miss: both callers get the value", a === "v1" && b === "v1", [a, b]);

  // 2. fresh hit
  const c = await cached("k", fn);
  check("fresh hit: served from cache, no re-query", c === "v1" && calls === 1, { c, calls });

  // 3. stale hit: instant old value + exactly one background refresh
  await sleep(FRESH + 250);
  const t0 = Date.now();
  const d = await cached("k", fn);
  const staleElapsed = Date.now() - t0;
  check("stale hit: returns previous value", d === "v1", d);
  check(`stale hit: instant (<${INSTANT_MS}ms, loader takes ${LOAD_MS}ms)`, staleElapsed < INSTANT_MS, staleElapsed);
  const [e1, e2] = await Promise.all([cached("k", fn), cached("k", fn)]);
  check("stale hits while refreshing: still instant old value", e1 === "v1" && e2 === "v1", [e1, e2]);
  // Refresh takes LOAD_MS; check well after it finished but well inside the
  // new entry's fresh window (age ~LOAD_MS+250 << FRESH).
  await sleep(LOAD_MS + 250);
  check("background refresh ran exactly once", calls === 2, calls);
  const f = await cached("k", fn);
  check("after refresh: next hit serves the NEW value", f === "v2", f);
}

async function testKeepWindowExpiry() {
  // Isolated cache/key so earlier background refreshes cannot shift `at`.
  const KEEP = 900;
  const cached = createQueryCache({ maxEntries: 10, freshMs: 300, keepMs: KEEP });
  let calls = 0;
  const fn = async () => {
    calls++;
    await sleep(LOAD_MS);
    return `v${calls}`;
  };
  await cached("kk", fn); // seed v1
  await sleep(KEEP + 500); // age ~KEEP+500: past keep window by a wide margin
  const t0 = Date.now();
  const g = await cached("kk", fn);
  const blockElapsed = Date.now() - t0;
  check("past keep window: reload returns current value", g === "v2" && calls === 2, { g, calls });
  check("past keep window: reload blocks (no ancient data served)", blockElapsed >= LOAD_MS - 50, blockElapsed);
}

async function testRefreshConcurrencyGate() {
  const FRESH = 400;
  const cached = createQueryCache({ maxEntries: 20, freshMs: FRESH, keepMs: 60_000 });
  const REFRESH_MS = 150;
  let running = 0;
  let maxRunning = 0;
  let done = 0;
  const mk = (i: number) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await sleep(REFRESH_MS);
    running--;
    done++;
    return i;
  };

  // Seed 6 keys sequentially (like the boot warm-up does), let them go stale.
  for (let i = 0; i < 6; i++) await cached(`g${i}`, mk(i));
  maxRunning = 0; // only measure the background-refresh phase
  await sleep(FRESH + 200);

  // One page view finding 6 stale entries at once (dashboard fan-out).
  const t0 = Date.now();
  const vals = await Promise.all(Array.from({ length: 6 }, (_, i) => cached(`g${i}`, mk(i))));
  check("gate: all 6 stale hits answered instantly", Date.now() - t0 < INSTANT_MS, Date.now() - t0);
  check("gate: all 6 served their stale values", vals.every((v, i) => v === i), vals);
  await sleep(REFRESH_MS * 4 + 600); // 6 refreshes at concurrency 2 ≈ 3 waves
  check("gate: every stale entry got refreshed", done === 12, done);
  check("gate: never more than 2 refreshes in flight", maxRunning <= 2 && maxRunning > 0, maxRunning);
}

async function testRefreshFailureBackoff() {
  const FRESH = 300;
  const cached = createQueryCache({ maxEntries: 10, freshMs: FRESH, keepMs: 60_000 });
  let calls = 0;
  let failNext = false;
  const fn = async () => {
    calls++;
    if (failNext) throw new Error("simulated upstream failure");
    return "ok";
  };
  await cached("f", fn); // seed (calls = 1)
  await sleep(FRESH + 200);
  failNext = true;
  const v1 = await cached("f", fn); // stale hit -> background refresh fails
  check("failed refresh: stale value still served", v1 === "ok", v1);
  await sleep(300); // let the failing refresh settle (calls = 2)
  const v2 = await cached("f", fn); // within cooldown -> must NOT retry yet
  await sleep(300);
  check("failed refresh: cooldown prevents immediate retry", calls === 2, calls);
  check("failed refresh: entry retained for later retries", v2 === "ok", v2);
}

async function testEvictionBound() {
  const cached = createQueryCache({ maxEntries: 3, freshMs: 60_000, keepMs: 120_000 });
  let calls = 0;
  for (let i = 0; i < 5; i++) await cached(`m${i}`, async () => ++calls);
  check("eviction: each new key loads once", calls === 5, calls);
  const v4 = await cached("m4", async () => ++calls);
  check("eviction: newest entries kept", v4 === 5 && calls === 5, { v4, calls });
  await cached("m0", async () => ++calls);
  check("eviction: oldest entry evicted at the bound", calls === 6, calls);
}

async function main() {
  console.log("audit:cache-swr — verifying stale-while-revalidate cache contract...");
  await testSwrLifecycle();
  await testKeepWindowExpiry();
  await testRefreshConcurrencyGate();
  await testRefreshFailureBackoff();
  await testEvictionBound();

  if (failures > 0) {
    console.error(`\naudit:cache-swr: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\naudit:cache-swr: all checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("audit:cache-swr crashed:", err);
  process.exit(1);
});
