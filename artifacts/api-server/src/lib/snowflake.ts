import crypto from "node:crypto";
import snowflake from "snowflake-sdk";
import { logger } from "./logger";

// Keep the SDK's own logging quiet; we log through pino.
snowflake.configure({ logLevel: "ERROR" });

export class SnowflakeConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Snowflake is not configured. Missing secrets: ${missing.join(", ")}. ` +
        "Add them as Replit secrets, and make sure the matching RSA public key " +
        "is registered on the Snowflake user (ALTER USER ... SET RSA_PUBLIC_KEY = '...').",
    );
    this.name = "SnowflakeConfigError";
  }
}

interface SnowflakeConfig {
  account: string;
  username: string;
  privateKey: string;
  privateKeyPass?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
}

function getConfig(): SnowflakeConfig {
  const account = process.env.SNOWFLAKE_ACCOUNT;
  const username = process.env.SNOWFLAKE_USER;
  const privateKey = process.env.SNOWFLAKE_PRIVATE_KEY;

  const missing: string[] = [];
  if (!account) missing.push("SNOWFLAKE_ACCOUNT");
  if (!username) missing.push("SNOWFLAKE_USER");
  if (!privateKey) missing.push("SNOWFLAKE_PRIVATE_KEY");
  if (missing.length > 0) throw new SnowflakeConfigError(missing);

  return {
    account: account!,
    username: username!,
    privateKey: normalizePrivateKey(
      privateKey!,
      process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE || undefined,
    ),
    privateKeyPass: undefined,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || undefined,
    database: process.env.SNOWFLAKE_DATABASE || undefined,
    schema: process.env.SNOWFLAKE_SCHEMA || undefined,
    role: process.env.SNOWFLAKE_ROLE || undefined,
  };
}

/**
 * Accepts a private key as PEM (encrypted or not, with real or literal "\n"
 * newlines) or as a bare base64 DER body, decrypts it if a passphrase is
 * provided, and returns an unencrypted PKCS#8 PEM for the Snowflake SDK.
 */
function normalizePrivateKey(raw: string, passphrase?: string): string {
  const withNewlines = raw.replace(/\\n/g, "\n").trim();

  const candidates: string[] = [];
  if (withNewlines.includes("-----BEGIN")) {
    candidates.push(withNewlines);
  } else {
    const body = withNewlines.replace(/\s+/g, "");
    const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
    for (const label of [
      "ENCRYPTED PRIVATE KEY",
      "PRIVATE KEY",
      "RSA PRIVATE KEY",
    ]) {
      candidates.push(
        `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`,
      );
    }
  }

  let lastError: unknown;
  for (const pem of candidates) {
    try {
      const keyObject = crypto.createPrivateKey({
        key: pem,
        format: "pem",
        passphrase,
      });
      return keyObject.export({ type: "pkcs8", format: "pem" }) as string;
    } catch (err) {
      lastError = err;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  if (/bad decrypt|passphrase|password/i.test(message) || !passphrase) {
    throw new Error(
      "Could not read SNOWFLAKE_PRIVATE_KEY. The key appears to be encrypted or malformed. " +
        "If it is encrypted, set SNOWFLAKE_PRIVATE_KEY_PASSPHRASE. " +
        `Underlying error: ${message}`,
    );
  }
  throw new Error(`Could not read SNOWFLAKE_PRIVATE_KEY: ${message}`);
}

function createConnection(): snowflake.Connection {
  const config = getConfig();
  return snowflake.createConnection({
    account: config.account,
    username: config.username,
    authenticator: "SNOWFLAKE_JWT",
    privateKey: config.privateKey,
    privateKeyPass: config.privateKeyPass,
    warehouse: config.warehouse,
    database: config.database,
    schema: config.schema,
    role: config.role,
  });
}

let connectionPromise: Promise<snowflake.Connection> | null = null;

async function connect(): Promise<snowflake.Connection> {
  const connection = createConnection();
  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => (err ? reject(err) : resolve()));
  });
  logger.info("Connected to Snowflake");
  return connection;
}

async function getConnection(): Promise<snowflake.Connection> {
  if (!connectionPromise) {
    connectionPromise = connect().catch((err) => {
      // Don't cache failed connections.
      connectionPromise = null;
      throw err;
    });
  }
  const connection = await connectionPromise;
  if (!connection.isUp()) {
    connectionPromise = null;
    return getConnection();
  }
  return connection;
}

/**
 * Run a SQL query against Snowflake and return the result rows.
 * Use `binds` for parameterized values (`?` placeholders).
 */
export async function querySnowflake<T = Record<string, unknown>>(
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<T[]> {
  const connection = await getConnection();
  return new Promise<T[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) {
          logger.error({ err: err.message }, "Snowflake query failed");
          reject(err);
        } else {
          resolve((rows ?? []) as T[]);
        }
      },
    });
  });
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
    return {
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
