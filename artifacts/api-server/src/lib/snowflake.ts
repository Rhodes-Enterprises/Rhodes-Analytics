import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";
import {
  RATE_LIMIT_BACKOFF_CAP_MS,
  RATE_LIMIT_MAX_RETRIES,
  TRANSIENT_MAX_RETRIES,
  isRequestTimeoutError,
  isTransientNetworkError,
  retryAfterBaseMs,
  sleep,
  summarizeError,
  transientBackoffMs,
} from "./transient";

/**
 * Snowflake access via the Replit Snowflake connector (SQL REST API through
 * the authenticated proxy). Credentials/OAuth are managed by the integration;
 * only the session context (database/schema/warehouse) comes from env vars.
 */

export class SnowflakeConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Snowflake is not configured. Missing environment variables: ${missing.join(", ")}.`,
    );
    this.name = "SnowflakeConfigError";
  }
}

interface SessionContext {
  database: string;
  schema: string;
  warehouse?: string;
}

function getContext(): SessionContext {
  const database = process.env.SNOWFLAKE_DATABASE;
  const schema = process.env.SNOWFLAKE_SCHEMA;
  const missing: string[] = [];
  // Dashboard queries use unqualified table names and rely on the session
  // namespace, so an active database/schema is required — fail loudly.
  if (!database) missing.push("SNOWFLAKE_DATABASE");
  if (!schema) missing.push("SNOWFLAKE_SCHEMA");
  if (missing.length > 0) throw new SnowflakeConfigError(missing);
  return {
    // The SQL API treats context values as case-sensitive identifiers and
    // expects the canonical (uppercase) form unless quoted when created.
    database: database!.toUpperCase(),
    schema: schema!.toUpperCase(),
    warehouse: process.env.SNOWFLAKE_WAREHOUSE?.toUpperCase() || undefined,
  };
}
export type Bind = string | number;

interface RowTypeCol {
  name: string;
  type: string;
}

interface ResultSet {
  resultSetMetaData?: {
    numRows?: number;
    rowType?: RowTypeCol[];
    partitionInfo?: { rowCount: number }[];
  };
  data?: (string | null)[][];
  statementHandle?: string;
  statementStatusUrl?: string;
  code?: string;
  message?: string;
}

function toBindings(binds: Bind[]): Record<string, { type: string; value: string }> {
  const bindings: Record<string, { type: string; value: string }> = {};
  binds.forEach((v, i) => {
    bindings[String(i + 1)] = {
      type: typeof v === "number" ? "FIXED" : "TEXT",
      value: String(v),
    };
  });
  return bindings;
}

/** Convert a raw SQL API cell (always a string) to a JS value by column type. */
function convertCell(raw: string | null, type: string): unknown {
  if (raw === null) return null;
  switch (type.toUpperCase()) {
    case "FIXED":
    case "REAL":
      return Number(raw);
    case "BOOLEAN":
      return raw === "true";
    case "DATE": {
      // Days since epoch.
      const ms = Number(raw) * 86400_000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    case "TIMESTAMP_NTZ":
    case "TIMESTAMP_LTZ":
    case "TIMESTAMP_TZ": {
      // Seconds since epoch (TZ variant appends " <offsetMinutes>").
      const seconds = Number(raw.split(" ")[0]);
      return new Date(seconds * 1000).toISOString();
    }
    default:
      return raw;
  }
}

// Retries alone are not enough: the ~10 RPS budget is shared by the whole
// repl (API server AND audit processes), and every proxied request counts —
// statement POSTs, status polls, partition fetches. Boot cache warming plus
// a running audit can fan out enough parallel requests that sustained 429s
// exhaust the bounded retries and surface as user-facing 502s. So every
// proxied request passes through a process-wide gate that caps in-flight
// requests and spaces request starts, keeping each process at or below
// ~5 req/s; the retries then only absorb cross-process overlap, not
// same-process bursts. Tune via env if the proxy budget ever changes.
const MAX_IN_FLIGHT = Math.max(1, Number(process.env.SNOWFLAKE_MAX_IN_FLIGHT ?? "5"));
const MIN_START_SPACING_MS = Math.max(
  0,
  Number(process.env.SNOWFLAKE_MIN_START_SPACING_MS ?? "200"),
);

let inFlightRequests = 0;
let nextStartAt = 0;
const slotWaiters: (() => void)[] = [];

/**
 * Acquire a pacer slot, waiting no later than `deadlineAt`. Returns false
 * (holding nothing) if the deadline passes first. Slot wakeups carry no
 * capacity — a woken waiter re-checks the count — so an abandoned wakeup is
 * passed on to the next waiter rather than lost.
 */
async function acquireProxySlot(deadlineAt: number): Promise<boolean> {
  while (inFlightRequests >= MAX_IN_FLIGHT) {
    if (Date.now() >= deadlineAt) return false;
    let wake!: () => void;
    const woken = new Promise<boolean>((resolve) => {
      wake = () => resolve(true);
      slotWaiters.push(wake);
    });
    if (!(await raceDeadline(woken, deadlineAt, false))) {
      const idx = slotWaiters.indexOf(wake);
      if (idx >= 0) slotWaiters.splice(idx, 1);
      // Not queued anymore: a release woke us in the same tick the deadline
      // fired. Forward that "re-check now" signal so it isn't swallowed.
      else slotWaiters.shift()?.();
      return false;
    }
  }
  inFlightRequests++;
  const now = Date.now();
  const startAt = Math.max(now, nextStartAt);
  nextStartAt = startAt + MIN_START_SPACING_MS;
  // The spacing wait is clipped to the deadline: a request whose start slot
  // lies beyond its budget wakes AT the deadline (still holding the pacer
  // slot) and the caller's remaining-budget check fails it immediately.
  if (startAt > now) await sleep(Math.min(startAt, deadlineAt) - now);
  return true;
}

function releaseProxySlot(): void {
  inFlightRequests--;
  slotWaiters.shift()?.();
}

// Stall protection: without a per-request deadline, one wedged proxy socket
// holds a live dashboard request for however long Node's own socket limits
// take (~5 minutes of silence) while the user stares at a spinner. Every
// proxied request therefore carries AbortSignal.timeout, sized comfortably
// above normal proxy latency — including the ~45s the SQL API legitimately
// blocks on a statement submit before going async with a 202 — so a stalled
// attempt aborts quickly, classifies as transient ("TimeoutError" in
// transient.ts), and is retried. Empty or garbage env values fall back to
// the default rather than silently disabling the deadline.
const rawRequestTimeoutMs = Number(process.env.SNOWFLAKE_REQUEST_TIMEOUT_MS ?? "");
const REQUEST_TIMEOUT_MS =
  Number.isFinite(rawRequestTimeoutMs) && rawRequestTimeoutMs > 0 ? rawRequestTimeoutMs : 60_000;

// Overall budget for one QUERY, end to end: waiting for a statement slot,
// the submit exchange (including throttle-gate and pacer waits, retries,
// and backoffs), and 202 polling all draw down this one deadline. It must
// cover queue time too: under a hung proxy, a fan-out's second wave would
// otherwise inherit a fresh full budget after waiting out the first, turning
// "about two minutes" into multi-minute waves. Default keeps ~2 stalled
// attempts (2 × REQUEST_TIMEOUT_MS) inside the budget. Env override exists
// for ops tuning and so the offline stall audit can shrink timescales;
// empty or garbage values fall back to the default.
const rawQueryDeadlineMs = Number(process.env.SNOWFLAKE_QUERY_DEADLINE_MS ?? "");
const QUERY_DEADLINE_MS =
  Number.isFinite(rawQueryDeadlineMs) && rawQueryDeadlineMs > 0 ? rawQueryDeadlineMs : 120_000;

/**
 * Race `promise` against a wall-clock deadline. Resolves with `onDeadline`
 * if the deadline passes first. The timer is cleared as soon as the promise
 * settles, so no stray timeout lingers (a leaked 120s timer per queued
 * request would, among other things, hold audit processes open at exit).
 */
function raceDeadline<T>(promise: Promise<T>, deadlineAt: number, onDeadline: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onDeadline), Math.max(0, deadlineAt - Date.now()));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let pausedUntil = 0;

/** The named fail-fast error every deadline-exhausted wait surfaces. */
function retryDeadlineError(init: ProxyRequestInit, path: string, attempts: number): Error {
  return new Error(
    `Snowflake proxy request ${init.method} ${path} ran out of its retry deadline after ${attempts} attempt(s) without a usable response — failing fast instead of hanging`,
  );
}

/**
 * One proxied JSON exchange with bounded retries. `deadlineAt` caps the
 * WHOLE call — every attempt, backoff, stall, throttle-gate wait, and pacer
 * queue wait — so retried stalls cannot stack per-attempt timeouts end to
 * end and a closed gate cannot hold a request past its budget: submits and
 * polls draw down their query's single deadline, while partition fetches
 * each get a fresh budget.
 */
async function proxyJson(
  path: string,
  init: ProxyRequestInit,
  deadlineAt: number,
): Promise<{ status: number; json: ResultSet }> {
  let status = 0;
  let text = "";
  let retryAfterHeader: string | null = null;
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    let failed = false;
    let caught: unknown;
    // Never hold a pacer slot while the 429 pause gate is closed: wait
    // first, then acquire, and re-check in case a 429 landed while queued.
    // Both waits are bounded by `deadlineAt`; a request that cannot get a
    // usable slot inside its budget fails with the named error rather than
    // queueing silently behind a stalled or throttled proxy.
    for (;;) {
      await awaitThrottleGate(deadlineAt);
      if (!(await acquireProxySlot(deadlineAt))) {
        throw retryDeadlineError(init, path, attempt);
      }
      if (pausedUntil <= Date.now() || Date.now() >= deadlineAt) break;
      releaseProxySlot();
    }
    // Per-attempt stall deadline, clipped to the call's remaining overall
    // budget so retries never extend past `deadlineAt`.
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      releaseProxySlot();
      throw retryDeadlineError(init, path, attempt);
    }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
    try {
      // The signal covers the whole exchange — connect, headers, AND the
      // body read below — so a stall at any stage rejects with a
      // "TimeoutError" DOMException, which transient.ts classifies as
      // retryable.
      const response = await snowflakeTestHooks.transport(path, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      retryAfterHeader = response.headers.get("retry-after");
      // Read the body inside the try: a connection dropped mid-body (e.g.
      // "terminated" / ECONNRESET) is just as transient as a failed connect.
      text = await response.text();
    } catch (err) {
      failed = true;
      caught = err;
    } finally {
      // Release before any retry sleep so a throttled or failed request
      // doesn't hold a slot while it waits.
      releaseProxySlot();
    }
    if (failed) {
      if (
        attempt < TRANSIENT_MAX_RETRIES &&
        Date.now() < deadlineAt &&
        isTransientNetworkError(caught)
      ) {
        logger.warn(
          { path, attempt: attempts, timeoutMs, err: summarizeError(caught) },
          "Transient Snowflake proxy network error — retrying",
        );
        // Backoff clipped to the deadline: waking at the deadline makes the
        // next attempt's budget checks throw the named error right away, so
        // a query can only overrun its budget by scheduler jitter.
        await sleep(Math.min(transientBackoffMs(attempt), Math.max(0, deadlineAt - Date.now())));
        continue;
      }
      // A bare timeout DOMException reads "The operation was aborted due to
      // timeout" with no hint of what hung — name the stalled request so the
      // dashboard's 502 has a clear cause in the server logs.
      if (isRequestTimeoutError(caught)) {
        throw new Error(
          `Snowflake proxy request ${init.method} ${path} stalled: no usable response within ${timeoutMs}ms (attempt ${attempts}) — failing fast instead of hanging`,
          { cause: caught },
        );
      }
      throw caught;
    }
    if (status === 429) {
      // Arm the process-wide pause gate on EVERY throttle response —
      // including the terminal attempt — so ALL queued requests wait out
      // the proxy's Retry-After window together instead of piling onto a
      // known-throttled proxy the moment this request's slot frees.
      noteThrottled(retryAfterHeader, attempt);
    }
    // 429 gets a larger budget than other retryable statuses: it is explicit
    // backpressure, and a saturated proxy can stay saturated for tens of
    // seconds while a parallel dashboard load drains.
    const maxRetries = status === 429 ? RATE_LIMIT_MAX_RETRIES : TRANSIENT_MAX_RETRIES;
    if (isRetryableStatus(status) && attempt < maxRetries && Date.now() < deadlineAt) {
      logger.warn(
        { path, attempt: attempts, status },
        "Transient Snowflake proxy HTTP status — retrying",
      );
      // A throttled request waits at the top of the next attempt via the
      // shared pause gate (no double-sleep); other retryable statuses back
      // off locally — clipped to the deadline like every other wait here.
      if (status !== 429) {
        await sleep(Math.min(transientBackoffMs(attempt), Math.max(0, deadlineAt - Date.now())));
      }
      continue;
    }
    break;
  }

  let json: ResultSet;
  try {
    json = JSON.parse(text) as ResultSet;
  } catch {
    throw new Error(
      `Snowflake API returned non-JSON response (HTTP ${status}${
        isRetryableStatus(status) ? ` after ${attempts} attempts` : ""
      }): ${text.slice(0, 200)}`,
    );
  }
  if ((status < 200 || status >= 300) && status !== 202) {
    throw new Error(
      `Snowflake query failed (HTTP ${status}${
        isRetryableStatus(status) ? ` after ${attempts} attempts` : ""
      }): ${json.message ?? text.slice(0, 200)}`,
    );
  }
  return { status, json };
}

function pollDelayMs(poll: number): number {
  return Math.min(1000 + Math.max(0, poll - 3) * 500, 3000) + Math.floor(Math.random() * 250);
}
async function pollStatement(handle: string, deadlineAt: number): Promise<ResultSet> {
  for (let poll = 0; ; poll++) {
    // Poll delay clipped to wake just past the deadline, with the deadline
    // checked AFTER the sleep: expiry mid-delay fires the named error at the
    // deadline (never a full poll interval late), and a zero-budget poll is
    // never issued.
    await sleep(Math.min(pollDelayMs(poll), Math.max(0, deadlineAt - Date.now()) + 1));
    if (Date.now() >= deadlineAt) {
      throw new Error(
        `Snowflake statement ${handle} did not finish within the query deadline (${Math.round(QUERY_DEADLINE_MS / 1000)}s total including queue time) — giving up instead of hanging`,
      );
    }
    // Polls draw down the query's one deadline, so a stalled poll's retries
    // can never outlive what this query was promised at submit time.
    const { status, json } = await proxyJson(
      `/api/v2/statements/${handle}`,
      { method: "GET" },
      deadlineAt,
    );
    if (status === 200) return json;
    // 202: still running — keep polling.
  }
}

/**
 * Run a SQL query against Snowflake and return the result rows as objects
 * keyed by column name. Use `binds` for parameterized values (`?` placeholders).
 */
export async function querySnowflake<T = Record<string, unknown>>(
  sqlText: string,
  binds: Bind[] = [],
): Promise<T[]> {
  const context = getContext();
  const body: Record<string, unknown> = {
    statement: sqlText,
    timeout: 90,
    database: context.database,
    schema: context.schema,
  };
  if (context.warehouse) body.warehouse = context.warehouse;
  if (binds.length > 0) body.bindings = toBindings(binds);

  // ONE deadline bounds this query end to end — including time spent QUEUED
  // for a statement slot behind other statements. Under a hung proxy, every
  // wave of a fan-out would otherwise inherit a fresh full budget after
  // waiting out the previous one, so a user could still stare at a spinner
  // for many minutes; with the shared deadline, every concurrent query fails
  // clearly within about this one window.
  const deadlineAt = Date.now() + QUERY_DEADLINE_MS;

  // Hold a slot for the statement's whole lifecycle (submit → poll →
  // partition fetches) so its request budget stays accounted for.
  if (!(await statementSlots.acquire(deadlineAt))) {
    const err = new Error(
      `Snowflake query gave up after ${Math.round(QUERY_DEADLINE_MS / 1000)}s waiting for a statement slot — upstream is stalled or saturated; failing fast instead of hanging`,
    );
    logger.error({ err: err.message }, "Snowflake query failed");
    throw err;
  }
  try {
    let { status, json } = await proxyJson(
      "/api/v2/statements",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      deadlineAt,
    );
    if (status === 202) {
      if (!json.statementHandle) {
        throw new Error("Snowflake returned 202 without a statement handle");
      }
      json = await pollStatement(json.statementHandle, deadlineAt);
    }

    const rowType = json.resultSetMetaData?.rowType ?? [];
    const rows: T[] = [];
    const pushRows = (data: (string | null)[][] | undefined) => {
      for (const raw of data ?? []) {
        const row: Record<string, unknown> = {};
        rowType.forEach((col, i) => {
          row[col.name] = convertCell(raw[i] ?? null, col.type);
        });
        rows.push(row as T);
      }
    };
    pushRows(json.data);

    // Fetch remaining partitions, if any (partition 0 is the initial body).
    // Each partition fetch gets a FRESH stall budget on purpose: by now data
    // is flowing (every completed fetch proves the proxy alive), and a large
    // export may legitimately need longer than one query deadline end to
    // end. The deadline exists to kill silent stalls, and each fetch still
    // carries its own per-attempt timeouts and bounded retries.
    const partitions = json.resultSetMetaData?.partitionInfo ?? [];
    for (let p = 1; p < partitions.length; p++) {
      const { json: part } = await proxyJson(
        `/api/v2/statements/${json.statementHandle}?partition=${p}`,
        { method: "GET" },
        Date.now() + QUERY_DEADLINE_MS,
      );
      pushRows(part.data);
    }
    return rows;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Snowflake query failed",
    );
    throw err;
  } finally {
    statementSlots.release();
  }
}

export interface SnowflakeStatus {
  connected: boolean;
  version?: string;
  user?: string;
  role?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  error?: string;
}

/** Verify the connection end to end and report the active session context. */
export async function checkSnowflake(): Promise<SnowflakeStatus> {
  try {
    const rows = await querySnowflake<Record<string, string | null>>(
      `SELECT CURRENT_VERSION() AS "version",
              CURRENT_USER() AS "user",
              CURRENT_ROLE() AS "role",
              CURRENT_WAREHOUSE() AS "warehouse",
              CURRENT_DATABASE() AS "database",
              CURRENT_SCHEMA() AS "schema"`,
    );
    const row = rows[0] ?? {};
    return {
      connected: true,
      version: row.version ?? undefined,
      user: row.user ?? undefined,
      role: row.role ?? undefined,
      warehouse: row.warehouse ?? undefined,
      database: row.database ?? undefined,
      schema: row.schema ?? undefined,
    };
  } catch (err) {
    // Log the detailed cause server-side only; never expose raw upstream
    // connector/Snowflake error messages to clients.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Snowflake status probe failed",
    );
    const generic =
      err instanceof SnowflakeConfigError
        ? err.message
        : "Unable to reach Snowflake. See server logs for details.";
    return { connected: false, error: generic };
  }
}

// Above the per-request pacer sits a statement-level cap: a statement's
// whole lifecycle (submit → 202 polls → partition fetches) holds one slot,
// so a 14-query dashboard fan-out queues instead of opening 14 statements
// whose polls all compete through the pacer at once. Waiters are FIFO.
const MAX_CONCURRENT_STATEMENTS = 7;

/**
 * Test seam for the offline rate-limit audit (audit:throttle): the audit
 * swaps `transport` for canned responses to prove the retry, pause-gate,
 * and concurrency-cap contracts without network access. Production code
 * must never reassign this.
 */
export const snowflakeTestHooks: {
  transport: (path: string, init: ProxyRequestInit) => Promise<ProxyTransportResponse>;
  readonly rateLimitMaxRetries: number;
  readonly maxConcurrentStatements: number;
  /** Effective per-attempt stall deadline (env-resolved) — for audit:stall. */
  readonly requestTimeoutMs: number;
  /** Effective end-to-end query budget (env-resolved) — for audit:stall. */
  readonly queryDeadlineMs: number;
} = {
  transport: connectorTransport,
  rateLimitMaxRetries: RATE_LIMIT_MAX_RETRIES,
  maxConcurrentStatements: MAX_CONCURRENT_STATEMENTS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  queryDeadlineMs: QUERY_DEADLINE_MS,
};

/** 429 = proxy rate limit; 5xx = gateway/upstream hiccup. Other 4xx are real errors. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

class Semaphore {
  private free: number;
  private readonly waiters: (() => void)[] = [];
  constructor(size: number) {
    this.free = size;
  }
  /**
   * Acquire a slot, waiting no later than `deadlineAt`. Returns false
   * (holding nothing) if the deadline passes first. Unlike pacer wakeups,
   * a semaphore wakeup HANDS OVER a slot, so a wakeup that races the
   * deadline is returned via release() rather than lost.
   */
  async acquire(deadlineAt: number): Promise<boolean> {
    if (this.free > 0) {
      this.free--;
      return true;
    }
    let wake!: () => void;
    const woken = new Promise<boolean>((resolve) => {
      wake = () => resolve(true);
      this.waiters.push(wake);
    });
    if (await raceDeadline(woken, deadlineAt, false)) return true;
    const idx = this.waiters.indexOf(wake);
    if (idx >= 0) {
      this.waiters.splice(idx, 1);
      return false;
    }
    // A release consumed our resolver in the same tick the deadline fired:
    // we own a slot we no longer want — pass it on.
    this.release();
    return false;
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

const statementSlots = new Semaphore(MAX_CONCURRENT_STATEMENTS);

interface ProxyRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-attempt stall deadline; proxyJson attaches one to every attempt. */
  signal?: AbortSignal;
}

// Cooperative process-wide brake on top of the pacer: when ANY request gets
// a 429, all proxy traffic from this process (submits and polls alike)
// pauses until the Retry-After horizon passes. Without it, every in-flight
// statement burns its own retry budget probing a proxy that already said
// "slow down". Delay math delegates to the shared transient-retry policy.
function noteThrottled(retryAfterHeader: string | null, attempt: number): void {
  const delayMs = transientBackoffMs(
    attempt,
    retryAfterBaseMs(retryAfterHeader),
    RATE_LIMIT_BACKOFF_CAP_MS,
  );
  pausedUntil = Math.max(pausedUntil, Date.now() + delayMs);
}

async function awaitThrottleGate(deadlineAt: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    const waitMs = pausedUntil - now;
    // Returns when the gate is open OR the caller's deadline has passed —
    // the caller re-checks its budget and fails fast with the named error,
    // so a gate repeatedly re-armed by other traffic's 429s can never hold
    // one request beyond its own deadline.
    if (waitMs <= 0 || now >= deadlineAt) return;
    // Small extra jitter staggers the herd released when the gate opens.
    const ms = Math.min(waitMs + Math.floor(Math.random() * 250), deadlineAt - now);
    await sleep(ms);
  }
}

async function connectorTransport(
  path: string,
  init: ProxyRequestInit,
): Promise<ProxyTransportResponse> {
  // Never cache the client — the SDK handles token refresh per call.
  // createProxyFetch (not .proxy(), whose options accept no signal) forwards
  // the per-attempt abort signal to the underlying fetch and keeps it across
  // the SDK's internal 401 token-refresh retry, so the stall deadline covers
  // every socket this exchange may open. The SDK's identity minting ahead of
  // the fetch is separately bounded internally (~5s), so no stage of an
  // exchange can stall unbounded.
  const connectors = new ReplitConnectors();
  const proxyFetch = connectors.createProxyFetch("snowflake");
  return proxyFetch(path, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
    body: init.body,
    signal: init.signal,
  });
}

/** Shape of one raw proxy exchange; structurally satisfied by fetch's Response. */
export interface ProxyTransportResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
