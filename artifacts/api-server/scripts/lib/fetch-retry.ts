/**
 * Shared JSON fetch for the audit scripts, with bounded retries on
 * TRANSPORT-level hiccups only:
 *
 *  - thrown network errors (fetch failed / ECONNRESET / timeouts), and
 *  - HTTP 429 / 5xx responses — the API server sits in front of the
 *    rate-limited Snowflake connector proxy, so a cold-cache burst of
 *    upstream queries can transiently surface as a 5xx here.
 *
 * Every attempt also carries a hard deadline (AUDIT_FETCH_TIMEOUT_MS):
 * without one, a single stalled response holds the audit for however long
 * Node's own socket timeouts take (~5 minutes per stall). A timed-out
 * attempt counts as a transient failure — the API server keeps computing
 * and caching after the client gives up, so a retry usually lands on the
 * finished result — while a persistently hung endpoint exhausts the bounded
 * retries and fails the audit well inside the umbrella runner's per-audit
 * budget (AUDIT_TIMEOUT_MS in scripts/audit-all.mjs).
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

/**
 * Per-attempt request deadline. Generous, because the private audit server
 * starts cold and its heaviest endpoints legitimately spend a while on
 * first-touch Snowflake queries behind the rate-limited proxy — but small
 * enough that a hung endpoint's full retry chain
 * ((TRANSIENT_MAX_RETRIES + 1) × deadline + backoffs ≈ 12.5 min at the
 * default) still fails the audit inside the umbrella runner's per-audit
 * budget rather than being killed by it without a specific error.
 */
const rawFetchTimeoutMs = Number(process.env.AUDIT_FETCH_TIMEOUT_MS ?? "");
export const FETCH_TIMEOUT_MS =
  Number.isFinite(rawFetchTimeoutMs) && rawFetchTimeoutMs > 0 ? rawFetchTimeoutMs : 120_000;

/** True when the error is the DOMException AbortSignal.timeout() rejects with. */
function isRequestTimeout(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError"
  );
}

export async function fetchJsonWithRetry<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let status: number;
    let ok: boolean;
    let body: string;
    let retryAfterHeader: string | null;
    try {
      // The signal covers the whole attempt — connect, headers, AND body
      // (the body read below shares this request's signal) — so a stall at
      // any stage rejects with a "TimeoutError" DOMException, which
      // transient.ts classifies as retryable.
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      status = res.status;
      ok = res.ok;
      retryAfterHeader = res.headers.get("retry-after");
      // Body read stays inside the try: a connection dropped mid-body is
      // just as transient as a failed connect.
      body = await res.text();
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      const detail = isRequestTimeout(err)
        ? `no response within AUDIT_FETCH_TIMEOUT_MS=${FETCH_TIMEOUT_MS}ms`
        : summarizeError(err);
      if (attempt < TRANSIENT_MAX_RETRIES) {
        console.warn(
          `  transient network error on GET ${url} — retrying (attempt ${attempt + 1}/${TRANSIENT_MAX_RETRIES + 1}): ${detail}`,
        );
        await sleep(transientBackoffMs(attempt));
        continue;
      }
      throw new Error(
        `GET ${url} still failing after ${TRANSIENT_MAX_RETRIES + 1} attempts (last error: ${detail}) — failing the audit instead of hanging`,
        { cause: err },
      );
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
