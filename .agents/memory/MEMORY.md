# Memory Index

- [Snowflake connection quirks](snowflake-connection.md) — connector proxy: ~10 RPS/repl limit (429s) + transient 5xx, heavy-tailed latency (benchmark via interleaved medians), SELECT grants gotcha.
- [DM_GOALS data model](goal-data-model.md) — daily-distributed goals, GOAL_TYPE naming (regime starts FY2026; earlier years legacy names → zero targets), channel/division definitions; Qlik-validated.
- [Breakdown row seeding](goal-data-model.md) — breakdown tables must seed rows from actuals too, not just goals/GA rows, or developments with sales but no goals vanish silently (audit sum-check catches this).
- [DM_COMPANY_DEVELOPMENT flags](dm-company-development-flags.md) — flags are labels ('Has Goals'/'Rental'), not Yes/No; IFF dedup single-sourced in shared dev-dim module — never re-copy it.
- [Ratio goals & ratio audits](goal-data-model.md) — goal-ratio input table has junk NULL rows (filter year, skip nulls); resolve names both directions; audit derived ratios with compounded (1+t)/(1−t) tolerance.
- [Stale local build state](stale-project-references.md) — "no exported member" = stale lib dist/ (tsc -b, --force if no-op); instant ERR_MODULE_NOT_FOUND after a rebase = stale node_modules (pnpm install).
- [Audit scripts bypass tsc](audit-scripts-not-typechecked.md) — scripts/ is outside tsconfig include; esbuild won't catch renamed helpers after rebases — grep grafted call sites, smoke-run before completing.
- [Chart-vs-table & label-drift nets](audit-consistency-nets.md) — Σ monthly==totals same-response checks, float-only tolerance, vacuity guards; label guards when audits hardcode literals.
- [Dashboard query cache](dashboard-query-cache.md) — all dashboard libs use the shared SWR cache; refreshes traffic-triggered only (warehouse credits), one global 2-wide refresh gate (proxy 10 RPS).
- [Audit tolerance conventions](audit-conventions.md) — same-day-cached endpoints: bound by today-stamped activity + slack, never exact/flat; "today" = America/Chicago, never UTC; prove checks can fail via doctoring proxy.
- [Audit timeout layering](audit-conventions.md) — request deadline ×(retries+1)+backoffs must fit the per-audit budget; kill stuck audits via detached process group (killing pnpm orphans them).
- [Headless browser automation](browser-automation.md) — playwright-core + Nix chromium; UI audits: page's own XHR, param-multiset wiring, route-hold lifecycle proof vs vacuous equality, retry-tolerant 5xx.
- [Client date-range guards](date-range-guards.md) — guard lone (single-set) dates too, and anchor client "today" to America/Chicago like the server: viewer-clock guards fail at quarter/year boundaries.
- [Cohort & lead-source filters](cohort-leadsource-filters.md) — cohort = create quarter (same-quarter filter no-ops leads; tours carry signal); pick lead sources that also have deals in range.
- [Batched audit baselines](batched-audit-baselines.md) — collapse scalar counts into COUNT_IF/GROUP BY scans (0==missing, bind order: subquery SELECT binds first); UNION ALL for different date axes.
- [Env-var number parsing](env-var-parsing.md) — Number("") is 0, not NaN: unset env + ">= 0" guard silently disables budgets; treat empty as absent, and test the genuinely UNSET path.
- [In-process warm-up audit](in-process-audit-pattern.md) — warm-vs-request key drift needs real warm fn + real router + cache observer in one process; --packages=external breaks on workspace TS-source pkgs.
- [Auto-merge verification](automerge-verification.md) — assisted rounds can corrupt regions outside markers; mid-rebase the tree lacks still-queued commits — check before re-implementing "lost" work.
