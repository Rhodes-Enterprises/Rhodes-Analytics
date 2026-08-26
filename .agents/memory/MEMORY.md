# Memory Index

- [Snowflake connection quirks](snowflake-connection.md) — connector proxy: ~10 RPS/repl limit (429s) + transient 5xx, heavy-tailed latency (benchmark via interleaved medians), SELECT grants gotcha.
- [DM_GOALS data model](goal-data-model.md) — daily-distributed goals, target→GOAL_TYPE naming, actual/channel/division definitions validated against Qlik; reuse for the other marketing dashboards.
- [Breakdown row seeding](goal-data-model.md) — breakdown tables must seed rows from actuals too, not just goals/GA rows, or developments with sales but no goals vanish silently (audit sum-check catches this).
- [DM_COMPANY_DEVELOPMENT flags](dm-company-development-flags.md) — flags are labels ('Has Goals'/'Rental'), not Yes/No; IFF dedup single-sourced in shared dev-dim module — never re-copy it.
- [Ratio goals & ratio audits](goal-data-model.md) — goal-ratio input table has junk NULL rows (filter year, skip nulls); resolve names both directions; audit derived ratios with compounded (1+t)/(1−t) tolerance.
- [Chart-vs-table & label-drift nets](audit-consistency-nets.md) — Σ monthly==totals same-response checks, float-only tolerance, vacuity guards; label guards when audits hardcode literals.
- [Dashboard query cache](dashboard-query-cache.md) — all dashboard libs use the shared SWR cache; refreshes traffic-triggered only (warehouse credits), one global 2-wide refresh gate (proxy 10 RPS).
- [Audit tolerance conventions](audit-conventions.md) — same-day-cached endpoints: bound by today-stamped activity + small slack, never exact/flat tolerance; prove new checks can fail via a doctoring proxy.
- [Headless browser automation](browser-automation.md) — playwright-core + Nix chromium via executablePath (downloaded browsers fail on NixOS); UI-binding audits: page's own XHR, exact header multisets, mutation-test.
- [Client date-range guards](date-range-guards.md) — guard lone (single-set) dates too: the API fills the missing side from today, so a lone out-of-year date 400s before the pair is complete.
