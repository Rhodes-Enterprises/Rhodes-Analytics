# Memory Index

- [Snowflake connection quirks](snowflake-connection.md) — key normalization (bare base64 + passphrase), snowflake-sdk esbuild-external, ~10 RPS proxy limit (429s) + transient 5xx, SELECT grants gotcha.
- [DM_GOALS data model](goal-data-model.md) — daily-distributed goals, target→GOAL_TYPE naming, actual/channel/division definitions validated against Qlik; reuse for the other marketing dashboards.
- [Breakdown row seeding](goal-data-model.md) — breakdown tables must seed rows from actuals too, not just goals/GA rows, or developments with sales but no goals vanish silently (audit sum-check catches this).
- [DM_COMPANY_DEVELOPMENT flags](dm-company-development-flags.md) — flags are labels ('Has Goals'/'Rental'), not Yes/No; IFF dedup single-sourced in shared dev-dim module — never re-copy it.
- [Ratio goals & ratio audits](goal-data-model.md) — goal-ratio input table has junk NULL rows (filter year, skip nulls); resolve names both directions; audit derived ratios with compounded (1+t)/(1−t) tolerance.
- [Stale TS project references](stale-project-references.md) — "no exported member" from @workspace libs during typecheck usually means stale dist/ declarations; run tsc -b on the lib first.
- [Chart-vs-table consistency nets](audit-consistency-nets.md) — same-page chart+table use separate queries; audit Σ monthly == totals within one response, float-only tolerance, vacuity guards.
