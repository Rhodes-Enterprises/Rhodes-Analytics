---
name: DM_COMPANY_DEVELOPMENT flag values
description: Flag columns are text labels, not Yes/No; string-DESC dedup silently inverts goal preference.
---

- `DEVELOPMENT_HAS_GOALS_FLAG` values are `'Has Goals'` / `'No Goals'`; `RENTAL_COMMUNITY_FLAG` values are `'Rental'` / `'For Sale'` (NULL possible). Comparing against `'Yes'`/`'TRUE'` matches nothing.
- **Why:** The Community List shipped with dead badges/toggles because of this. Also `ORDER BY DEVELOPMENT_HAS_GOALS_FLAG DESC` prefers `'No Goals'` ('N' > 'H' alphabetically), silently inverting an intended "prefer the goal-carrying row" dedup.
- **How to apply:** Compare with the exact labels (`= 'Has Goals'`, `= 'Rental'`) and dedup with `IFF(DEVELOPMENT_HAS_GOALS_FLAG = 'Has Goals', 0, 1)`. The shared DEV_DIM and both audit-script mirrors (dashboard + yoy) now all use the IFF ordering — any new copy of the dedup must too, and the API dimension and audit mirrors must change in lockstep or audits flag false regressions.
- Duplicate-development data is dbt-rebuilt and shifts over time: by Aug 2026 the only Esperanza duplicates ('Future Master', 'VDL Lots') carried uniform 'No Goals' flags, so correcting the ordering changed no attribution that day (COMPANY_NAME tie-break decided both). Don't assume a planned data-dependent impact still exists — measure at fix time.
