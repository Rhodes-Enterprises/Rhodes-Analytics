/**
 * Snowflake stall-protection audit (`pnpm run audit:stall`).
 *
 * Verifies the contracts in lib/snowflake.ts that keep ONE wedged proxy
 * socket from holding a live dashboard request for multiple minutes:
 *
 *  1. every transport attempt carries an abort signal (per-attempt
 *     AbortSignal.timeout), and a stalled attempt aborts with a
 *     "TimeoutError", classifies transient, and is RETRIED
 *  2. a persistently hung proxy fails with a clear error NAMING the stalled
 *     request, within scheduler tolerance of the query deadline — retried
 *     stalls never stack their per-attempt timeouts end to end, and a
 *     deadline landing mid-backoff or mid-poll-delay fires AT the deadline
 *     (all waits are clipped), never a full interval late
 *  3. the deadline covers QUEUE time too: a query stuck waiting for a
 *     statement slot behind hung statements fails at its own deadline, not
 *     after the whole first wave drains (no fresh budget per wave)
 *  4. a throttle-gate pause armed by OTHER traffic's 429 cannot hold a
 *     request past its deadline
 *  5. a legitimately slow response under the per-attempt deadline still
 *     succeeds on the first attempt (production default keeps ~15s of
 *     headroom above the ~45s the SQL API may block on a submit)
 *  6. partition fetches get a FRESH stall budget each (large exports must
 *     not be killed by the end-to-end query deadline once data is flowing)
 *  7. the production DEFAULTS keep those margins: ~60s per attempt (>50s),
 *     query deadline ≥ 2 per-attempt timeouts (re-checked in a child
 *     process with the env overrides stripped)
 *
 * Pure offline test: the transport seam is swapped for canned responses —
 * no Snowflake traffic, no API server needed (AUDIT_API_BASE is ignored).
 * Timescales are shrunk via SNOWFLAKE_REQUEST_TIMEOUT_MS=300 and
 * SNOWFLAKE_QUERY_DEADLINE_MS=2000 in the `audit:stall` script command; the
 * behavior under test is scale-free. The request-level pacer is neutralized
 * via env (like audit:throttle) so deadline behavior — not request spacing —
 * decides every scenario's timing. Runs in ~25 seconds.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import { execFileSync } from "node:child_process";
import {
  querySnowflake,
  snowflakeTestHooks,
  type ProxyTransportResponse,
} from "../src/lib/snowflake";

// ---------------------------------------------------------------------------
// print-defaults mode: a child process re-runs this bundle with the env
// overrides stripped and reports the module's effective (default) config.
// Must run before the main-mode env guard below.
if (process.env.AUDIT_STALL_MODE === "print-defaults") {
  console.log(
    JSON.stringify({
      requestTimeoutMs: snowflakeTestHooks.requestTimeoutMs,
      queryDeadlineMs: snowflakeTestHooks.queryDeadlineMs,
    }),
  );
  process.exit(0);
}

// querySnowflake requires a session context; values are irrelevant offline.
process.env.SNOWFLAKE_DATABASE ??= "AUDIT_DB";
process.env.SNOWFLAKE_SCHEMA ??= "AUDIT_SCHEMA";

// Fail fast if someone edits the audit:stall script command and drops the
// shrunken-timescale env overrides — at production scale this audit would
// "pass" by taking many minutes or time out at the runner instead.
const REQUEST_TIMEOUT_MS = snowflakeTestHooks.requestTimeoutMs;
const QUERY_DEADLINE_MS = snowflakeTestHooks.queryDeadlineMs;
if (
  REQUEST_TIMEOUT_MS !== 300 ||
  QUERY_DEADLINE_MS !== 2000 ||
  Number(process.env.SNOWFLAKE_MIN_START_SPACING_MS ?? "200") !== 0 ||
  Number(process.env.SNOWFLAKE_MAX_IN_FLIGHT ?? "5") < 20
) {
  console.error(
    "audit:stall: run via `pnpm run audit:stall` — it must set SNOWFLAKE_REQUEST_TIMEOUT_MS=300, " +
      "SNOWFLAKE_QUERY_DEADLINE_MS=2000, SNOWFLAKE_MAX_IN_FLIGHT=50 and " +
      "SNOWFLAKE_MIN_START_SPACING_MS=0 so the stall scenarios run at audit timescale with " +
      `the pacer neutral (got requestTimeoutMs=${REQUEST_TIMEOUT_MS}, queryDeadlineMs=${QUERY_DEADLINE_MS}).`,
  );
  process.exit(1);
}

// A hung "socket" here is a bare promise, which does not hold Node's event
// loop the way a real socket does (and AbortSignal.timeout timers are
// unref'd) — so keep a ref'd timer alive for the duration and flag any
// premature exit as a failure instead of a silent false green.
let finished = false;
const keepalive = setInterval(() => {}, 30_000);
process.on("exit", () => {
  if (!finished) {
    console.error("FAIL audit:stall exited before completing its scenarios");
    process.exitCode = 1;
  }
});

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

function res(status: number, body: unknown, retryAfter?: string): ProxyTransportResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        retryAfter !== undefined && name.toLowerCase() === "retry-after" ? retryAfter : null,
    },
    text: async () => JSON.stringify(body),
  };
}

/** Minimal successful single-row result set. */
function okResult(extra: Record<string, unknown> = {}, cell = "1"): unknown {
  return {
    resultSetMetaData: {
      numRows: 1,
      rowType: [{ name: "N", type: "FIXED" }],
      ...extra,
    },
    data: [[cell]],
  };
}

// Every canned transport funnels through here so the signal contract is
// asserted on EVERY attempt of EVERY scenario.
let missingSignalAttempts = 0;
const abortReasonNames: string[] = [];
function guardSignal(init: { signal?: AbortSignal }): AbortSignal | undefined {
  if (!init.signal) missingSignalAttempts++;
  return init.signal;
}

/** A wedged socket: never responds, rejects with the signal's reason on abort. */
function hang(init: { signal?: AbortSignal }): Promise<ProxyTransportResponse> {
  const signal = guardSignal(init);
  if (!signal) {
    return Promise.reject(new Error("audit:stall: attempt carried no abort signal"));
  }
  return new Promise((_, reject) => {
    const onAbort = () => {
      const reason = signal.reason as { name?: string };
      abortReasonNames.push(typeof reason?.name === "string" ? reason.name : String(reason));
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settle<T>(p: Promise<T>): Promise<{ ok: boolean; value?: T; err?: Error }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, err: err as Error };
  }
}

async function main() {
  // ------------------------------------------------------------------
  // 7. Production defaults keep the stall margins (child process with the
  //    timescale overrides stripped; empty string = unset by design — the
  //    module must treat empty env as absent, not as 0).
  console.log("audit:stall — checking production-default margins in a child process...");
  try {
    const out = execFileSync(process.execPath, [process.argv[1]!], {
      env: {
        ...process.env,
        AUDIT_STALL_MODE: "print-defaults",
        SNOWFLAKE_REQUEST_TIMEOUT_MS: "",
        SNOWFLAKE_QUERY_DEADLINE_MS: "",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    const defaults = JSON.parse(out.trim()) as {
      requestTimeoutMs: number;
      queryDeadlineMs: number;
    };
    check(
      "defaults: per-attempt deadline is 60s (empty env falls back, not 0)",
      defaults.requestTimeoutMs === 60_000,
      defaults,
    );
    check(
      "defaults: query deadline is 120s (empty env falls back, not 0)",
      defaults.queryDeadlineMs === 120_000,
      defaults,
    );
    check(
      "defaults: per-attempt deadline clears the ~45s a legit submit may block (>50s)",
      defaults.requestTimeoutMs > 50_000,
      defaults,
    );
    check(
      "defaults: query deadline fits >=2 stalled attempts (>= 2x per-attempt)",
      defaults.queryDeadlineMs >= 2 * defaults.requestTimeoutMs,
      defaults,
    );
  } catch (err) {
    check("defaults: child process reported the default config", false, err);
  }

  // ------------------------------------------------------------------
  // 1. One stalled attempt aborts at the per-attempt deadline and is
  //    retried; the retry succeeds.
  {
    let calls = 0;
    snowflakeTestHooks.transport = (_path, init) => {
      calls++;
      guardSignal(init);
      return calls === 1 ? hang(init) : Promise.resolve(res(200, okResult()));
    };
    const t0 = Date.now();
    const r = await settle(querySnowflake("SELECT STALL_THEN_RECOVER"));
    const elapsed = Date.now() - t0;
    check("stall→recover: query succeeds after one stalled attempt", r.ok, r.err?.message);
    check("stall→recover: exactly 2 attempts (stall aborted, retry served)", calls === 2, calls);
    check(
      `stall→recover: first attempt aborted at ~${REQUEST_TIMEOUT_MS}ms (elapsed ${elapsed}ms)`,
      elapsed >= REQUEST_TIMEOUT_MS && elapsed < QUERY_DEADLINE_MS,
      elapsed,
    );
  }

  // ------------------------------------------------------------------
  // 2. A persistently hung proxy fails clearly within the query deadline.
  {
    let calls = 0;
    snowflakeTestHooks.transport = (_path, init) => {
      calls++;
      return hang(init);
    };
    const t0 = Date.now();
    const r = await settle(querySnowflake("SELECT ALWAYS_HUNG"));
    const elapsed = Date.now() - t0;
    check("hung proxy: query fails (never hangs)", !r.ok);
    check(
      "hung proxy: error names the stalled request",
      /POST \/api\/v2\/statements/.test(r.err?.message ?? "") &&
        /stalled: no usable response within|ran out of its retry deadline/.test(
          r.err?.message ?? "",
        ),
      r.err?.message,
    );
    check("hung proxy: stalled attempt was retried (>=2 attempts)", calls >= 2, calls);
    check(
      `hung proxy: failed AT the query deadline (${elapsed}ms for ${QUERY_DEADLINE_MS}ms budget) — stalls never stack, backoffs never overrun`,
      elapsed >= QUERY_DEADLINE_MS - 150 && elapsed < QUERY_DEADLINE_MS + 400,
      elapsed,
    );
  }

  // ------------------------------------------------------------------
  // 5. A slow-but-healthy response under the per-attempt deadline succeeds
  //    (scaled analog of the ~45s legit submit block vs the 60s default).
  {
    let calls = 0;
    snowflakeTestHooks.transport = async (_path, init) => {
      calls++;
      guardSignal(init);
      await sleep(200);
      return res(200, okResult());
    };
    const r = await settle(querySnowflake("SELECT LEGIT_SLOW"));
    check("legit slow: response under the per-attempt deadline succeeds", r.ok, r.err?.message);
    check("legit slow: exactly 1 attempt (no premature abort)", calls === 1, calls);
  }

  // ------------------------------------------------------------------
  // 3a. The deadline covers statement-queue time: queries stuck behind a
  //     wave of hung statements fail at THEIR OWN deadline, not deadline ×
  //     waves. Depending on whether a wave slot frees just before a queued
  //     query's deadline, it exits through the slot-timeout or the proxy
  //     retry-deadline path — both named, both bounded; scenario 3b pins
  //     the slot-timeout path deterministically.
  {
    snowflakeTestHooks.transport = (_path, init) => hang(init);
    const hungWave = Array.from({ length: snowflakeTestHooks.maxConcurrentStatements }, (_, i) =>
      settle(querySnowflake(`SELECT HUNG_${i}`)),
    );
    await sleep(100); // let the wave claim every statement slot
    const t0 = Date.now();
    const queued = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        settle(querySnowflake(`SELECT QUEUED_${i}`)).then((r) => ({
          ...r,
          elapsed: Date.now() - t0,
        })),
      ),
    );
    check(
      "queued queries: all fail while the hung wave holds the slots",
      queued.every((q) => !q.ok),
      queued.map((q) => q.ok),
    );
    check(
      "queued queries: every failure is a named fail-fast error",
      queued.every((q) =>
        /waiting for a statement slot|ran out of its retry deadline|stalled: no usable response within/.test(
          q.err?.message ?? "",
        ),
      ),
      queued.map((q) => q.err?.message),
    );
    check(
      `queued queries: each failed at its own deadline (${queued
        .map((q) => q.elapsed)
        .join(", ")}ms), no fresh budget per wave`,
      queued.every(
        (q) => q.elapsed >= QUERY_DEADLINE_MS - 250 && q.elapsed < QUERY_DEADLINE_MS + 600,
      ),
      queued.map((q) => q.elapsed),
    );
    const wave = await Promise.all(hungWave);
    check(
      "hung wave: every stalled statement failed with a named error",
      wave.every(
        (w) =>
          !w.ok &&
          /stalled: no usable response within|ran out of its retry deadline|statement slot/.test(
            w.err?.message ?? "",
          ),
      ),
      wave.find((w) => w.ok) ?? wave[0]?.err?.message,
    );
  }

  // ------------------------------------------------------------------
  // 6. Partition fetches get a fresh stall budget each: a paged export whose
  //    total time exceeds one query deadline still completes (data is
  //    flowing; the deadline kills silent stalls, not big downloads).
  {
    const PARTITIONS = 10; // partition 0 arrives with the submit body
    let calls = 0;
    snowflakeTestHooks.transport = async (path, init) => {
      calls++;
      guardSignal(init);
      if (init.method === "POST") {
        return res(
          200,
          okResult(
            {
              partitionInfo: Array.from({ length: PARTITIONS }, () => ({ rowCount: 1 })),
            },
            "0",
          ),
        );
      }
      const partition = Number(new URL(`http://x${path}`).searchParams.get("partition"));
      await sleep(250); // healthy but slow page; 10 pages ≈ 2.5s > the 2s deadline
      return res(200, { data: [[String(partition)]] });
    };
    const t0 = Date.now();
    const r = await settle(querySnowflake<{ N: number }>("SELECT BIG_EXPORT"));
    const elapsed = Date.now() - t0;
    check("big export: paged fetch beyond one query deadline still succeeds", r.ok, r.err?.message);
    check(
      "big export: all partitions arrived",
      r.value?.length === PARTITIONS &&
        r.value.every((row, i) => row.N === i),
      r.value?.length,
    );
    check(
      `big export: total time exceeded one query deadline (${elapsed}ms > ${QUERY_DEADLINE_MS}ms)`,
      elapsed > QUERY_DEADLINE_MS,
      elapsed,
    );
    check("big export: one attempt per exchange (no spurious aborts)", calls === PARTITIONS, calls);
  }

  // ------------------------------------------------------------------
  // 2b. Deadline expiry DURING a retry backoff fires at the deadline, not a
  //     full backoff later: instant 503s make backoff sleeps dominate the
  //     timeline, so the budget must run out mid-backoff.
  {
    let calls = 0;
    snowflakeTestHooks.transport = (_path, init) => {
      calls++;
      guardSignal(init);
      return Promise.resolve(res(503, { message: "Service unavailable" }));
    };
    const t0 = Date.now();
    const r = await settle(querySnowflake("SELECT ALWAYS_503"));
    const elapsed = Date.now() - t0;
    check("backoff expiry: persistent 503 fails with the named deadline error", !r.ok && /ran out of its retry deadline/.test(r.err?.message ?? ""), r.err?.message);
    check("backoff expiry: the 503 was retried (>=2 attempts)", calls >= 2, calls);
    check(
      `backoff expiry: failed AT the deadline (${elapsed}ms), clipped mid-backoff`,
      elapsed >= QUERY_DEADLINE_MS - 150 && elapsed < QUERY_DEADLINE_MS + 400,
      elapsed,
    );
  }

  // ------------------------------------------------------------------
  // 2c. Deadline expiry DURING statement polling fires at the deadline, not
  //     a full poll interval later: the submit 202s instantly and every
  //     status poll stays 202, so poll delays dominate the timeline.
  {
    let calls = 0;
    snowflakeTestHooks.transport = (_path, init) => {
      calls++;
      guardSignal(init);
      return Promise.resolve(res(202, { statementHandle: "poll-hang" }));
    };
    const t0 = Date.now();
    const r = await settle(querySnowflake("SELECT NEVER_FINISHES"));
    const elapsed = Date.now() - t0;
    check(
      "poll expiry: never-finishing statement fails with the poll-deadline error",
      !r.ok && /did not finish within the query deadline/.test(r.err?.message ?? ""),
      r.err?.message,
    );
    check("poll expiry: statement was submitted and polled (>=2 exchanges)", calls >= 2, calls);
    check(
      `poll expiry: failed AT the deadline (${elapsed}ms), clipped mid-poll-delay`,
      elapsed >= QUERY_DEADLINE_MS - 150 && elapsed < QUERY_DEADLINE_MS + 400,
      elapsed,
    );
  }

  // ------------------------------------------------------------------
  // 4. LAST (it arms the process-wide pause gate for ~8s): a 429 pause from
  //    OTHER traffic cannot hold a request past its own deadline.
  {
    let calls = 0;
    snowflakeTestHooks.transport = (_path, init) => {
      calls++;
      guardSignal(init);
      return calls === 1
        ? Promise.resolve(res(429, { error: { message: "Rate limit exceeded" } }, "60"))
        : Promise.resolve(res(200, okResult()));
    };
    const tA = Date.now();
    const a = await settle(querySnowflake("SELECT ARMS_THE_GATE"));
    const elapsedA = Date.now() - tA;
    check(
      "gate: throttled query fails at its deadline instead of waiting out an 8s pause",
      !a.ok &&
        /ran out of its retry deadline/.test(a.err?.message ?? "") &&
        elapsedA >= QUERY_DEADLINE_MS - 250 &&
        elapsedA < QUERY_DEADLINE_MS + 400,
      { elapsedA, message: a.err?.message },
    );
    const tB = Date.now();
    const b = await settle(querySnowflake("SELECT BEHIND_THE_GATE"));
    const elapsedB = Date.now() - tB;
    check(
      "gate: a fresh query behind the closed gate fails at ITS deadline with the named error",
      !b.ok && /ran out of its retry deadline|waiting for a statement slot/.test(b.err?.message ?? ""),
      b.err?.message,
    );
    check(
      `gate: behind-the-gate query failed in about its own budget (${elapsedB}ms)`,
      elapsedB >= QUERY_DEADLINE_MS - 250 && elapsedB < QUERY_DEADLINE_MS + 400,
      elapsedB,
    );
    check("gate: the closed gate kept both queries off the proxy (1 transport call)", calls === 1, calls);
  }

  // ------------------------------------------------------------------
  // 3b. Deterministic statement-slot timeout. A ROGUE transport that ignores
  //     its abort signal and never settles keeps all statement slots pinned
  //     forever (a synthetic worst case — real fetch always rejects on
  //     abort), so a queued query can never be handed a slot and MUST fail
  //     through the "waiting for a statement slot" path at its own deadline.
  //     Runs last: the pinned slots and never-settling promises only unwind
  //     when the process exits.
  {
    // The gate scenario above armed the process-wide 429 pause (~8s from its
    // start, ~4s of it already spent). Wait out the remainder so the rogue
    // wave's submits actually START (a closed gate would fail them at their
    // deadlines and free their slots, breaking the "pinned forever" setup).
    await sleep(4500);
    let queuedCalls = 0;
    snowflakeTestHooks.transport = (_path, init) => {
      if (init.body?.includes("QUEUED2_")) {
        queuedCalls++;
        guardSignal(init);
        return Promise.resolve(res(200, okResult()));
      }
      guardSignal(init); // signal must still be attached, even though rogue ignores it
      return new Promise<ProxyTransportResponse>(() => {});
    };
    const pinned = Array.from({ length: snowflakeTestHooks.maxConcurrentStatements }, (_, i) =>
      settle(querySnowflake(`SELECT PINNED_${i}`)),
    );
    void pinned; // never settles by construction — intentionally not awaited
    await sleep(100); // let the rogue wave claim every statement slot
    const t0 = Date.now();
    const queued = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        settle(querySnowflake(`SELECT QUEUED2_${i}`)).then((r) => ({
          ...r,
          elapsed: Date.now() - t0,
        })),
      ),
    );
    check(
      "pinned slots: every queued query fails with the statement-slot timeout",
      queued.every((q) => !q.ok && /waiting for a statement slot/.test(q.err?.message ?? "")),
      queued.map((q) => q.err?.message),
    );
    check(
      `pinned slots: each failed at its own deadline (${queued
        .map((q) => q.elapsed)
        .join(", ")}ms)`,
      queued.every(
        (q) => q.elapsed >= QUERY_DEADLINE_MS - 250 && q.elapsed < QUERY_DEADLINE_MS + 400,
      ),
      queued.map((q) => q.elapsed),
    );
    check("pinned slots: queued queries never reached the transport", queuedCalls === 0, queuedCalls);
  }

  // ------------------------------------------------------------------
  check("signal contract: every transport attempt carried an abort signal", missingSignalAttempts === 0, missingSignalAttempts);
  check(
    "signal contract: stalled attempts aborted with TimeoutError (classified transient)",
    abortReasonNames.length > 0 && abortReasonNames.every((n) => n === "TimeoutError"),
    abortReasonNames,
  );

  if (failures > 0) {
    console.error(`\naudit:stall: ${failures} check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\naudit:stall: all checks passed.");
  }
  finished = true;
  clearInterval(keepalive);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? (err.stack ?? err.message) : err);
  finished = true;
  clearInterval(keepalive);
  process.exit(1);
});
