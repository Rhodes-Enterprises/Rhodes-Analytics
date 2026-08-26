---
name: Dashboard query cache (stale-while-revalidate)
description: Rules for the shared SWR cache all dashboard query layers must use, and why refreshes are traffic-triggered only
---

- All dashboard data layers must route Snowflake reads through the shared SWR cache (api-server lib/query-cache.ts factory; overview-targets re-exports an instance). Never re-copy a private TTL cache into a new lib — leasing once had its own copy and silently lacked single-flight dedupe.
  **Why:** per-lib copies drift (different semantics, no shared rate-limit gate), and plain TTL caches go cold every 5 minutes, which is exactly the "1–3s first load after every idle stretch" problem SWR was added to fix.
  **How to apply:** new dashboard lib → `createQueryCache({ maxEntries })` or reuse the exported `cached`; expired entries are served instantly and refreshed in the background.
- Cache refreshes must stay TRAFFIC-TRIGGERED only — no cron/setInterval warmers beyond the one-shot boot warm-up.
  **Why:** a timer that re-queries while nobody uses the dashboards keeps the Snowflake warehouse from auto-suspending and burns credits all night. Deliberate tradeoff: the first visit after a long idle stretch gets data as old as the idle stretch (bounded by a 24h keep window) while the refresh runs behind it.
- Background refreshes share ONE process-wide concurrency gate (2 at a time) across all cache instances, because a single page view can find ~15 stale entries at once and the connector proxy 429s past ~10 req/s per repl. Per-instance gates would multiply. Don't raise the cap without re-checking combined foreground+background burst.
- The SWR contract (instant stale serves, exactly-one refresh, gate cap, failure backoff) is enforced by the auto-discovered `audit:cache-swr` script; timing-sensitive checks there need >=250ms margins from every fresh/keep boundary or they flake at the boundary (a boundary-landing check once scheduled a bonus refresh and cascaded a false failure).
