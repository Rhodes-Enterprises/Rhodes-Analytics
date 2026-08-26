---
name: DM_COMPANY_DEVELOPMENT flag values
description: Flag columns are text labels, not Yes/No; string-DESC dedup silently inverts goal preference.
---

- `DEVELOPMENT_HAS_GOALS_FLAG` values are `'Has Goals'` / `'No Goals'`; `RENTAL_COMMUNITY_FLAG` values are `'Rental'` / `'For Sale'` (NULL possible). Comparing against `'Yes'`/`'TRUE'` matches nothing.
- **Why:** The Community List shipped with dead badges/toggles because of this. Also `ORDER BY DEVELOPMENT_HAS_GOALS_FLAG DESC` prefers `'No Goals'` ('N' > 'H' alphabetically), silently inverting an intended "prefer the goal-carrying row" dedup.
- **How to apply:** Compare with the exact labels (`= 'Has Goals'`, `= 'Rental'`) and dedup with `IFF(DEVELOPMENT_HAS_GOALS_FLAG = 'Has Goals', 0, 1)`. The dedup subquery is now single-sourced in a shared dev-dim module (a builder that also takes extra columns, e.g. for the Community List) imported by both the API data layers and the audit scripts — never reintroduce a hand-copied mirror; extend the shared builder instead. The audits' independence lives in HOW they use the mapping (IN (...) semi-joins that cannot fan out), not in a separate copy of its text.
- Duplicate-development data is dbt-rebuilt and shifts over time: by Aug 2026 the only Esperanza duplicates ('Future Master', 'VDL Lots') carried uniform 'No Goals' flags, so correcting the ordering changed no attribution that day (COMPANY_NAME tie-break decided both). Don't assume a planned data-dependent impact still exists — measure at fix time.
- A baseline that replicates an exact-label comparison agrees with the API on all-false if upstream ever relabels the values — audits validating label-derived flags must also assert the label domain itself (unexpected `DEVELOPMENT_HAS_GOALS_FLAG`/`RENTAL_COMMUNITY_FLAG` values fail the run rather than silently zeroing both sides).
