/**
 * Snowflake rate-limit guard audit (`pnpm run audit:throttle`).
 *
 * Verifies the contracts in lib/snowflake.ts that keep parallel dashboard
 * fan-outs from failing with "Snowflake query failed (HTTP 429)":
 *
 *  1. global cap: no matter how many queries fan out at once, at most
 *     MAX_CONCURRENT_STATEMENTS statements hold the proxy concurrently
 *  2. 429 retry: a throttled request waits out Retry-After and recovers;
 *     only persistent throttling exhausts the bounded retries
 *  3. process-wide pause gate: EVERY 429 arms the gate — including the
 *     terminal one that fails its own request — so the next proxy request
 *     is held until the Retry-After horizon passes instead of piling onto
 *     a proxy that just said "slow down"
 *  4. non-retryable upstream errors (real 4xx, not 429/5xx) still fail fast
 *
 * Pure offline test: the transport seam is swapped for canned responses —
 * no Snowflake traffic, no API server needed (AUDIT_API_BASE is ignored).
 * The request-level pacer (SNOWFLAKE_MAX_IN_FLIGHT / MIN_START_SPACING_MS)
 * is neutralized via env in the `audit:throttle` script command so the
 * statement cap stays the binding constraint under test.
 * Runs in a few seconds.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import {
  querySnowflake,
  snowflakeTestHooks,
  type ProxyTransportResponse,
} from "../src/lib/snowflake";

// querySnowflake requires a session context; values are irrelevant offline.
process.env.SNOWFLAKE_DATABASE ??= "AUDIT_DB";
process.env.SNOWFLAKE_SCHEMA ??= "AUDIT_SCHEMA";

// Fail fast if the pacer would mask the statement cap (e.g. someone edits
// the audit:throttle script command and drops the env overrides).
if (
  Number(process.env.SNOWFLAKE_MIN_START_SPACING_MS ?? "200") !== 0 ||
  Number(process.env.SNOWFLAKE_MAX_IN_FLIGHT ?? "5") < 20
) {
  console.error(
    "audit:throttle: run via `pnpm run audit:throttle` — it must set SNOWFLAKE_MIN_START_SPACING_MS=0 and SNOWFLAKE_MAX_IN_FLIGHT>=20 so the request pacer doesn't mask the statement cap under test.",
  );
  process.exit(1);
}

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

function res(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ProxyTransportResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

const OK_BODY = {
  resultSetMetaData: {
    numRows: 1,
    rowType: [{ name: "N", type: "FIXED" }],
    partitionInfo: [{ rowCount: 1 }],
  },
  data: [["1"]],
};
const THROTTLE_BODY = {
  error: { message: "Rate limit exceeded: 12/10 RPS for repl. Retry-After: 1" },
};
// Fractional Retry-After keeps the audit fast (50ms base instead of 1s);
// production proxies send whole seconds through the exact same code path.
const RETRY_AFTER = "0.05";
const BASE_MS = 50;
// Gate delay armed by the TERMINAL 429: min(base * (attempt + 1), 5000).
const MIN_TERMINAL_GATE_MS = Math.min(
  BASE_MS * (snowflakeTestHooks.rateLimitMaxRetries + 1),
  5000,
);

async function testConcurrencyCap() {
  let running = 0;
  let maxRunning = 0;
  snowflakeTestHooks.transport = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await sleep(100);
    running--;
    return res(200, OK_BODY);
  };
  const rows = await Promise.all(
    Array.from({ length: 20 }, () => querySnowflake<{ N: number }>("SELECT 1")),
  );
  check(
    "cap: all 20 parallel queries succeed",
    rows.length === 20 && rows.every((r) => r[0]?.N === 1),
    rows.length,
  );
  check(
    `cap: never more than ${snowflakeTestHooks.maxConcurrentStatements} statements in flight`,
    maxRunning === snowflakeTestHooks.maxConcurrentStatements,
    maxRunning,
  );
}

async function testRetryRecovers() {
  let calls = 0;
  snowflakeTestHooks.transport = async () => {
    calls++;
    return calls === 1
      ? res(429, THROTTLE_BODY, { "Retry-After": RETRY_AFTER })
      : res(200, OK_BODY);
  };
  const t0 = Date.now();
  const rows = await querySnowflake<{ N: number }>("SELECT 1");
  const elapsed = Date.now() - t0;
  check("retry: one 429 then success recovers", rows[0]?.N === 1 && calls === 2, { calls });
  check(
    `retry: waited out Retry-After before retrying (>=${BASE_MS}ms)`,
    elapsed >= BASE_MS - 5,
    elapsed,
  );
}

async function testTerminalGate() {
  let calls = 0;
  let last429At = 0;
  snowflakeTestHooks.transport = async () => {
    calls++;
    last429At = Date.now();
    return res(429, THROTTLE_BODY, { "Retry-After": RETRY_AFTER });
  };
  let error: unknown;
  try {
    await querySnowflake("SELECT 1");
  } catch (err) {
    error = err;
  }
  const attempts = snowflakeTestHooks.rateLimitMaxRetries + 1;
  check(
    "exhaustion: persistently throttled query fails loudly with HTTP 429",
    error instanceof Error && error.message.includes("HTTP 429"),
    String(error),
  );
  check(`exhaustion: gave the proxy ${attempts} chances first`, calls === attempts, calls);

  // The terminal 429 — the one that failed the query above — must still arm
  // the process-wide gate: the NEXT request may not reach the proxy until
  // its Retry-After horizon passes.
  let nextSentAt = 0;
  snowflakeTestHooks.transport = async () => {
    nextSentAt = Date.now();
    return res(200, OK_BODY);
  };
  const rows = await querySnowflake<{ N: number }>("SELECT 1");
  const gap = nextSentAt - last429At;
  check("terminal 429: next query succeeds once the gate opens", rows[0]?.N === 1, rows);
  check(
    `terminal 429: next proxy request held >=${MIN_TERMINAL_GATE_MS}ms by the pause gate`,
    gap >= MIN_TERMINAL_GATE_MS - 10,
    gap,
  );
  check("terminal 429: gate opens again (no permanent block)", gap < 4000, gap);
}

async function testNonRetryableFailsFast() {
  // 5xx statuses are retryable transients on main's shared policy, so the
  // fail-fast contract is asserted with a REAL client error (4xx ≠ 429).
  let calls = 0;
  snowflakeTestHooks.transport = async () => {
    calls++;
    return res(422, { message: "SQL compilation error" });
  };
  let error: unknown;
  try {
    await querySnowflake("SELECT 1");
  } catch (err) {
    error = err;
  }
  check(
    "non-retryable 4xx: upstream error fails fast with its status",
    error instanceof Error && error.message.includes("HTTP 422"),
    String(error),
  );
  check("non-retryable 4xx: no retry loop (exactly one attempt)", calls === 1, calls);
}

async function main() {
  console.log("audit:throttle — verifying Snowflake rate-limit guards (offline, mocked transport)...");
  await testConcurrencyCap();
  await testRetryRecovers();
  await testTerminalGate();
  await testNonRetryableFailsFast();

  if (failures > 0) {
    console.error(`\naudit:throttle: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\naudit:throttle: all checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("audit:throttle crashed:", err);
  process.exit(1);
});
