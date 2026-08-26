---
name: DM_COMPANY_DEVELOPMENT flag values
description: Flag columns are text labels, not Yes/No; string-DESC dedup silently inverts goal preference.
---

- `DEVELOPMENT_HAS_GOALS_FLAG` values are `'Has Goals'` / `'No Goals'`; `RENTAL_COMMUNITY_FLAG` values are `'Rental'` / `'For Sale'` (NULL possible). Comparing against `'Yes'`/`'TRUE'` matches nothing.
- **Why:** The Community List shipped with dead badges/toggles because of this. Also `ORDER BY DEVELOPMENT_HAS_GOALS_FLAG DESC` prefers `'No Goals'` ('N' > 'H' alphabetically), silently inverting an intended "prefer the goal-carrying row" dedup.
- **How to apply:** Compare with the exact labels (`= 'Has Goals'`, `= 'Rental'`) and dedup with `IFF(DEVELOPMENT_HAS_GOALS_FLAG = 'Has Goals', 0, 1)`. The shared DEV_DIM dimension in the API server's overview-targets lib still carries the inverted ordering — left untouched deliberately because fixing it shifts division attribution and must be coordinated with the dashboard regression baselines.
