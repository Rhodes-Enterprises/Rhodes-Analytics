/**
 * Cache observability hook shared by EVERY in-memory query cache in this
 * service. All caches are instances of createQueryCache (lib/query-cache.ts),
 * which emits here from its request path — so every store, including future
 * ones, is observed automatically. The warm-up audit
 * (scripts/audit-warmup.ts) subscribes to prove that the keys the startup
 * warm-up writes are the very keys real default HTTP requests read — if they
 * drift apart, warming "succeeds" while every first visitor silently pays
 * cold-query latency.
 *
 * Production runs with no observer: one null check per cache access.
 * If a lib ever grows a cache NOT built on createQueryCache, it MUST call
 * emitCacheAccess on every request-path access, or the warm-up audit will
 * (correctly) fail its endpoints with "no observed cache accesses".
 */
export interface CacheAccess {
  key: string;
  /**
   * hit: a cached entry answered instantly (fresh, or stale served under
   * stale-while-revalidate — either way no cold wait); miss: no servable
   * entry, foreground query executed; inflight-join: joined an in-progress
   * foreground fetch (caller still waits cold). Background revalidation is
   * deliberately NOT emitted.
   */
  outcome: "hit" | "miss" | "inflight-join";
}

let cacheObserver: ((access: CacheAccess) => void) | null = null;

export function setCacheObserver(
  observer: ((access: CacheAccess) => void) | null,
): void {
  cacheObserver = observer;
}

/** Called by each cached() implementation on every cache access. */
export function emitCacheAccess(key: string, outcome: CacheAccess["outcome"]): void {
  cacheObserver?.({ key, outcome });
}
