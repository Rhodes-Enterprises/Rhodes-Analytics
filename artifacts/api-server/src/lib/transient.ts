/**
 * Shared classification of TRANSPORT-level failures — cases where a request
 * never produced a usable HTTP response: reset/dropped connections, DNS
 * blips, connect/read timeouts. These are safe to retry for the read-only
 * queries this project makes.
 *
 * Real application failures (SQL errors, non-OK HTTP responses, mismatched
 * numbers in the audits) never match this classifier — they are not thrown
 * transport errors — and must surface immediately without retrying.
 *
 * Used by the Snowflake query helper (src/lib/snowflake.ts) and the audit
 * scripts' API fetch helper (scripts/lib/fetch-retry.ts) so every current
 * and future audit shares one retry policy. Keep this module dependency-free
 * so scripts can import it without dragging in server-only modules.
 */

/** Node/undici error codes that indicate a transient transport failure. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EAI_AGAIN",
  // DNS blip: the connector proxy host is fixed and known-good, so a failed
  // lookup is a resolver hiccup, not a configuration error.
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** undici error class names for timeouts / dropped sockets. */
const TRANSIENT_NAMES = new Set([
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
  // AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
  // The audits' fetch helper and the live server's Snowflake proxy calls
  // (src/lib/snowflake.ts) use it as a per-request deadline, and a request
  // that produced no response within its deadline is exactly the stalled
  // transport this classifier exists for. Deliberate cancellations reject as
  // "AbortError" instead and stay non-retryable.
  "TimeoutError",
]);

/**
 * Lowercase message substrings that indicate a transport failure. Only ever
 * matched against THROWN errors (never against HTTP response bodies), so
 * words like "terminated" cannot collide with SQL error text.
 */
const TRANSIENT_MESSAGE_PARTS = [
  "fetch failed", // undici umbrella for all transport-level fetch failures
  "socket hang up",
  "other side closed",
  "terminated",
  "premature close",
  "connection reset",
  "connection closed",
  "client network socket disconnected",
  "getaddrinfo",
  "network timeout",
];

function messageIsTransient(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_MESSAGE_PARTS.some((part) => lower.includes(part));
}

/**
 * Walk the error's `cause` chain (undici wraps the real cause inside
 * `TypeError: fetch failed`) looking for transport-level failure markers.
 * Unrecognized errors are NOT transient: a missing connection or a
 * programming error must fail fast, not burn retries.
 */
export function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (typeof current === "string") return messageIsTransient(current);
    if (typeof current !== "object") return false;
    const { code, name, message, cause } = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    if (typeof name === "string" && TRANSIENT_NAMES.has(name)) return true;
    if (typeof message === "string" && messageIsTransient(message)) return true;
    current = cause;
  }
  return false;
}

/**
 * True when the error is the "TimeoutError" DOMException that
 * AbortSignal.timeout() rejects with — a request that hit its per-request
 * stall deadline (already transient per the classifier above). Callers use
 * it to swap the bare DOMException ("The operation was aborted due to
 * timeout") for an error that names the stalled request.
 */
export function isRequestTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * Bounded retries for dropped connections and gateway hiccups (5xx): these
 * either clear quickly or indicate something genuinely broken.
 */
export const TRANSIENT_MAX_RETRIES = 5;

/**
 * HTTP 429 is not a hiccup — it is explicit backpressure with a Retry-After.
 * The proxy budget (~10 RPS per repl) is shared with concurrent dashboard
 * loads whose parallel statements + polling can saturate it for tens of
 * seconds, so rate-limit waits get a larger budget and a higher backoff cap
 * (worst case ≈ 40s of waiting) instead of failing a read-only query that
 * would succeed moments later.
 */
export const RATE_LIMIT_MAX_RETRIES = 8;
export const RATE_LIMIT_BACKOFF_CAP_MS = 8000;

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into a backoff
 * base in ms, or undefined when absent or unparseable. Callers still apply
 * the usual cap + jitter, so a huge or bogus value can't stall a retry loop.
 */
export function retryAfterBaseMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const sec = Number(header);
  if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return delta;
  }
  return undefined;
}

/**
 * Backoff before retry `attempt` (0-based): base, 2×base, ... capped, plus
 * up to 250ms of jitter so concurrent callers don't retry in lockstep.
 * `baseMs` defaults to 1s; pass a server-provided hint (e.g. a Retry-After
 * header converted to ms) to honor it while keeping the cap and jitter.
 */
export function transientBackoffMs(attempt: number, baseMs = 1000, capMs = 5000): number {
  return Math.min(baseMs * (attempt + 1), capMs) + Math.floor(Math.random() * 250);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Concise one-line error description including nested causes. */
export function summarizeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const { code, message, cause } = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const msg = typeof message === "string" && message !== "" ? message : String(current);
    parts.push(
      typeof code === "string" && code !== "" && !msg.includes(code)
        ? `${msg} [${code}]`
        : msg,
    );
    current = cause;
  }
  return parts.join(" <- ");
}
