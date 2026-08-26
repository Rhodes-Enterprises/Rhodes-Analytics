import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";

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

// The Snowflake proxy enforces a shared per-repl rate limit (10 RPS). Bursty
// dashboards + the audit script can exceed it; retry 429s with backoff
// instead of failing the request.
const RATE_LIMIT_MAX_RETRIES = 5;

async function proxyJson(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: ResultSet }> {
  const connectors = getConnectors();
  let response = await connectors.proxy("snowflake", path, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
    body: init.body,
  });
  for (let attempt = 1; response.status === 429 && attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    await response.text().catch(() => undefined); // drain before retrying
    const backoffMs = Math.min(1000 * attempt, 5000) + Math.floor(Math.random() * 250);
    await new Promise((r) => setTimeout(r, backoffMs));
    response = await connectors.proxy("snowflake", path, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init.headers,
      },
      body: init.body,
    });
  }
  const text = await response.text();
  let json: ResultSet;
  try {
    json = JSON.parse(text) as ResultSet;
  } catch {
    throw new Error(
      `Snowflake API returned non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(
      `Snowflake query failed (HTTP ${response.status}): ${json.message ?? text.slice(0, 200)}`,
    );
  }
  return { status: response.status, json };
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

async function pollStatement(handle: string): Promise<ResultSet> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`Snowflake statement ${handle} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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
