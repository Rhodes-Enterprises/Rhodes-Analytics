/**
 * Shared JSON fetch for the audit scripts, with bounded retries on
 * TRANSPORT-level hiccups only:
 *
 *  - thrown network errors (fetch failed / ECONNRESET / timeouts), and
 *  - HTTP 429 / 5xx responses — the API server sits in front of the
 *    rate-limited Snowflake connector proxy, so a cold-cache burst of
 *    upstream queries can transiently surface as a 5xx here.
 *
 * Anything else fails IMMEDIATELY: a non-OK 4xx response or a non-JSON body
 * is a real API contract failure the audit must report. Number comparisons
 * happen far above this layer and are never retried.
 */
import {
  RATE_LIMIT_BACKOFF_CAP_MS,
  RATE_LIMIT_MAX_RETRIES,
  TRANSIENT_MAX_RETRIES,
  isTransientNetworkError,
  retryAfterBaseMs,
  sleep,
  summarizeError,
  transientBackoffMs,
} from "../../src/lib/transient";

export async function fetchJsonWithRetry<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let status: number;
    let ok: boolean;
    let body: string;
    let retryAfterHeader: string | null;
    try {
      const res = await fetch(url);
      status = res.status;
      ok = res.ok;
      retryAfterHeader = res.headers.get("retry-after");
      // Body read stays inside the try: a connection dropped mid-body is
      // just as transient as a failed connect.
      body = await res.text();
    } catch (err) {
      if (attempt < TRANSIENT_MAX_RETRIES && isTransientNetworkError(err)) {
        console.warn(
          `  transient network error on GET ${url} — retrying (attempt ${attempt + 1}/${TRANSIENT_MAX_RETRIES + 1}): ${summarizeError(err)}`,
        );
        await sleep(transientBackoffMs(attempt));
        continue;
      }
      throw err;
    }
    // 429 waits longer than 5xx: it is explicit backpressure from the
    // rate-limited connector proxy behind the API (see transient.ts).
    const maxRetries = status === 429 ? RATE_LIMIT_MAX_RETRIES : TRANSIENT_MAX_RETRIES;
    if ((status === 429 || status >= 500) && attempt < maxRetries) {
      // On 429 honor the server's advertised Retry-After wait (still capped
      // and jittered — see transient.ts).
      const baseMs = status === 429 ? retryAfterBaseMs(retryAfterHeader) : undefined;
      console.warn(
        `  transient HTTP ${status} on GET ${url} — retrying (attempt ${attempt + 1}/${maxRetries + 1})`,
      );
      await sleep(
        transientBackoffMs(attempt, baseMs, status === 429 ? RATE_LIMIT_BACKOFF_CAP_MS : undefined),
      );
      continue;
    }
    if (!ok) {
      throw new Error(`GET ${url} failed with HTTP ${status}: ${body.slice(0, 500)}`);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(
        `GET ${url} returned non-JSON response (HTTP ${status}): ${body.slice(0, 200)}`,
      );
    }
  }
}
