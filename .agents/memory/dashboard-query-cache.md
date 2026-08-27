---
name: Dashboard query cache (stale-while-revalidate)
description: Rules for the shared SWR cache all dashboard query layers must use, and why refreshes are traffic-triggered only
---

- All dashboard data layers route Snowflake reads through the ONE shared SWR cache module — never a private per-lib TTL cache.
  **Why:** per-lib copies drift (one lib silently lost single-flight dedupe), and plain TTL caches go cold every expiry, recreating the slow-first-load problem SWR exists to fix.
  **How to apply:** new dashboard lib → reuse the shared cache factory/instance; stale entries serve instantly and refresh in the background.
- Cache refreshes stay TRAFFIC-TRIGGERED only (plus the one-shot boot warm-up) — no cron/interval warmers.
  **Why:** idle-time re-querying keeps the Snowflake warehouse from auto-suspending and burns credits all night. Accepted tradeoff: the first visit after a long idle stretch sees data as old as the idle stretch (bounded by the keep window) while a refresh runs behind it.
- Background refreshes share one small process-wide concurrency gate across ALL cache instances; don't raise it without re-checking the combined foreground+background burst against the proxy's ~10 req/s repl budget (one page view can find many stale entries at once).
- Cold-miss fan-outs need their own bound: the global refresh gate covers only SWR refreshes; an endpoint Promise.all of ~15 queries can alone breach the ~10 RPS proxy budget when contended (boot warm-up, audits). Cap per-endpoint bursts (~4-wide limiter).
- The SWR contract is enforced by an auto-discovered audit script; its timing-sensitive checks need >=250ms margins from every fresh/keep boundary or they flake at the boundary.
