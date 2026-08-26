import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";
import {
  RATE_LIMIT_BACKOFF_CAP_MS,
  RATE_LIMIT_MAX_RETRIES,
  TRANSIENT_MAX_RETRIES,
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

// Never cache the client — the SDK handles token refresh per call.
function getConnectors(): ReplitConnectors {
  return new ReplitConnectors();
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

async function acquireProxySlot(): Promise<void> {
  while (inFlightRequests >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => slotWaiters.push(resolve));
  }
  inFlightRequests++;
  const now = Date.now();
  const startAt = Math.max(now, nextStartAt);
  nextStartAt = startAt + MIN_START_SPACING_MS;
  if (startAt > now) await new Promise((r) => setTimeout(r, startAt - now));
}

function releaseProxySlot(): void {
  inFlightRequests--;
  slotWaiters.shift()?.();
}

async function proxyJson(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: ResultSet }> {
  let status = 0;
  let text = "";
  let retryAfterHeader: string | null = null;
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    let failed = false;
    let caught: unknown;
    await acquireProxySlot();
    try {
      // A fresh client per attempt — the SDK handles token refresh per call.
      const response = await getConnectors().proxy("snowflake", path, {
        method: init.method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...init.headers,
        },
        body: init.body,
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
      if (attempt < TRANSIENT_MAX_RETRIES && isTransientNetworkError(caught)) {
        logger.warn(
          { path, attempt: attempts, err: summarizeError(caught) },
          "Transient Snowflake proxy network error — retrying",
        );
        await sleep(transientBackoffMs(attempt));
        continue;
      }
      throw caught;
    }
    // 429 gets a larger budget than other retryable statuses: it is explicit
    // backpressure, and a saturated proxy can stay saturated for tens of
    // seconds while a parallel dashboard load drains.
    const maxRetries = status === 429 ? RATE_LIMIT_MAX_RETRIES : TRANSIENT_MAX_RETRIES;
    if (isRetryableStatus(status) && attempt < maxRetries) {
      // On 429 the proxy says how long to back off — honor it (still capped
      // and jittered so a burst of throttled queries doesn't retry in
      // lockstep or wait unboundedly long).
      const baseMs = status === 429 ? retryAfterBaseMs(retryAfterHeader) : undefined;
      logger.warn(
        { path, attempt: attempts, status },
        "Transient Snowflake proxy HTTP status — retrying",
      );
      await sleep(
        transientBackoffMs(attempt, baseMs, status === 429 ? RATE_LIMIT_BACKOFF_CAP_MS : undefined),
      );
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
const POLL_TIMEOUT_MS = 120_000;

function pollDelayMs(poll: number): number {
  return Math.min(1000 + Math.max(0, poll - 3) * 500, 3000) + Math.floor(Math.random() * 250);
}
async function pollStatement(handle: string): Promise<ResultSet> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (let poll = 0; ; poll++) {
    if (Date.now() > deadline) {
      throw new Error(`Snowflake statement ${handle} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
    }
    await sleep(pollDelayMs(poll));
    const { status, json } = await proxyJson(`/api/v2/statements/${handle}`, { method: "GET" });
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

  try {
    let { status, json } = await proxyJson("/api/v2/statements", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (status === 202) {
      if (!json.statementHandle) {
        throw new Error("Snowflake returned 202 without a statement handle");
      }
      json = await pollStatement(json.statementHandle);
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
    const partitions = json.resultSetMetaData?.partitionInfo ?? [];
    for (let p = 1; p < partitions.length; p++) {
      const { json: part } = await proxyJson(
        `/api/v2/statements/${json.statementHandle}?partition=${p}`,
        { method: "GET" },
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

/** 429 = proxy rate limit; 5xx = gateway/upstream hiccup. Other 4xx are real errors. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
