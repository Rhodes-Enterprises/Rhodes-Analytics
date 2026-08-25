---
name: Goal data model gotchas
description: Non-obvious rules for mapping Snowflake goals/actuals to the migrated Qlik marketing dashboards
---

# Goal data gotchas (marketing dashboards)

- DM_GOALS is **daily-distributed**: sum GOAL over the date range for a span goal and over range-start→today for a to-date goal. Do not prorate.
- The four dashboard targets are encoded in GOAL_TYPE naming conventions, and "Goal"/"Waterfall" are periodically re-issued (q1/q2/q3, monthly) — resolve the goal type at runtime by walking back to the latest existing period instead of hardcoding names. `old_*` and `RL_*` (rentals) variants must be excluded for EHI dashboards.
- **Why:** hardcoded goal types silently go stale when dbt adds the next quarter/month recalc.
- Division attribution for contacts/deals only works via the community-of-interest → DM_COMPANY_DEVELOPMENT.DEVELOPMENT_NAME join (~95% match; the rest, e.g. "General", stay unattributed) — expect division tables to sum below the grand totals, same as Qlik.
- GA data covers two brands; filter PROPERTY='Esperanza Homes' or Rhodes Living rental traffic inflates every web metric.
- Goals are issued per fiscal (calendar) year, so date ranges crossing a year boundary mix goal regimes — either aggregate per year or reject such ranges explicitly.
