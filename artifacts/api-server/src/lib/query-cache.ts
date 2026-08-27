import { logger } from "./logger";
import { emitCacheAccess } from "./cache-observer";

/**
 * Shared per-process query cache with stale-while-revalidate.
 *
 * Behavior per lookup:
 * - Fresh hit  (age < freshMs):  return the cached value.
 * - Stale hit  (age < keepMs):   return the cached value IMMEDIATELY and
 *   refresh it in the background, so the visitor never waits on Snowflake.
 * - Miss       (no entry / older than keepMs): load in the foreground with
 *   single-flight dedupe (concurrent callers share one query).
 *
 * Cost tradeoff (deliberate): refreshes are triggered ONLY by real traffic —
 * there is no timer/scheduler. An idle dashboard issues zero Snowflake
 * queries, so the warehouse can still auto-suspend instead of burning
 * credits all night. The price is that the first request after a long idle
 * stretch is served data as old as that idle stretch (bounded by keepMs)
 * while the refresh runs; the next request sees current data.
 *
 * Rate limiting: background refreshes across ALL cache instances share one
 * small concurrency gate. A single page view can find ~15 stale entries at
 * once (each dashboard fans out its queries), and the connector proxy allows
 * only ~10 req/s per repl (see .agents/memory/snowflake-connection.md) —
 * uncapped revalidation would burst past it and 429. Since stale responses
 * already went out, background refresh latency is invisible; a small cap
 * costs nothing.
 */

const DEFAULT_FRESH_MS = 5 * 60 * 1000; // serve without refresh below this age
const DEFAULT_KEEP_MS = 24 * 60 * 60 * 1000; // serve stale up to this age
const REFRESH_FAIL_COOLDOWN_MS = 60 * 1000; // per-key pause after a failed refresh
const MAX_CONCURRENT_REFRESHES = 2; // global, across all cache instances

interface Entry {
  at: number; // when the value was loaded
  value: unknown;
  refreshFailedAt?: number; // last failed background refresh, if any
}

// ---------- Global background-refresh gate (all caches share it) ----------

let activeRefreshes = 0;
const refreshWaiters: (() => void)[] = [];

function acquireRefreshSlot(): Promise<void> {
  if (activeRefreshes < MAX_CONCURRENT_REFRESHES) {
    activeRefreshes++;
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    refreshWaiters.push(() => {
      activeRefreshes++;
      resolve();
    }),
  );
}

function releaseRefreshSlot(): void {
  activeRefreshes--;
  const next = refreshWaiters.shift();
  if (next) next();
}

// ---------- Cache factory ----------

export interface QueryCacheOptions {
  maxEntries: number;
  /** Age below which entries are served as-is. Default 5 minutes. */
  freshMs?: number;
  /** Age below which expired entries are still served (with a background
   *  refresh). Older entries block on a foreground load. Default 24 hours. */
  keepMs?: number;
}

export type CachedFn = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createQueryCache(opts: QueryCacheOptions): CachedFn {
  const freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
  const keepMs = opts.keepMs ?? DEFAULT_KEEP_MS;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<unknown>>();
  const revalidating = new Set<string>();

  function store(key: string, value: unknown): void {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.at >= keepMs) cache.delete(k);
    }
    // Delete-then-set so a refreshed key moves to the back of the Map's
    // insertion order and oldest-first eviction tracks write recency.
    cache.delete(key);
    while (cache.size >= opts.maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(key, { at: now, value });
  }

  /** Single-flight load: caches on success, propagates failure to callers. */
  function load<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = (async () => {
      try {
        const value = await fn();
        store(key, value);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  function scheduleRevalidate(key: string, fn: () => Promise<unknown>): void {
    if (revalidating.has(key) || inflight.has(key)) return;
    const entry = cache.get(key);
    if (
      entry?.refreshFailedAt !== undefined &&
      Date.now() - entry.refreshFailedAt < REFRESH_FAIL_COOLDOWN_MS
    ) {
      return; // upstream just failed for this key; don't hammer it
    }
    revalidating.add(key);
    void (async () => {
      try {
        await acquireRefreshSlot();
        try {
          // May have waited in the queue; skip if a foreground miss (or an
          // earlier queued refresh) already brought the entry up to date.
          const current = cache.get(key);
          if (current && Date.now() - current.at < freshMs) return;
          await load(key, fn);
        } finally {
          releaseRefreshSlot();
        }
      } catch (err) {
        const current = cache.get(key);
        if (current) current.refreshFailedAt = Date.now();
        logger.warn(
          { key, err: err instanceof Error ? err.message : String(err) },
          "Background cache refresh failed; keeping stale entry",
        );
      } finally {
        revalidating.delete(key);
      }
    })();
  }

  return async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < freshMs) {
      emitCacheAccess(key, "hit");
      return hit.value as T;
    }
    if (hit && age < keepMs) {
      // Stale-while-revalidate: answer from cache now, refresh behind it.
      // Observed as a "hit": the caller got an instant response either way,
      // and the observer's consumers (the warm-up audit) care about cold
      // foreground waits, not freshness.
      emitCacheAccess(key, "hit");
      scheduleRevalidate(key, fn);
      return hit.value as T;
    }
    // Foreground load. Emit here rather than inside load() so that ONLY
    // request-path accesses reach the observer — load() also serves
    // background revalidation, which must stay invisible to it.
    emitCacheAccess(key, inflight.has(key) ? "inflight-join" : "miss");
    return load(key, fn);
  };
}
