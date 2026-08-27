---
name: Batched audit baselines
description: How to consolidate many scalar Snowflake baseline counts into few grouped/conditional-aggregation queries without weakening audit checks
---

# Batched audit baselines

The Snowflake proxy's ~10 RPS repl-wide cap makes round trips — not scan cost — dominate audit wall time. Consolidate per-scenario scalar counts into few queries; the checks, tolerances, and failure behavior stay identical because the same values come back.

**Patterns that preserve check-for-check equivalence:**
- **COUNT_IF over a flag subquery** replaces N scalar `COUNT(*)` queries on one table: subquery computes boolean window/label flags (`date BETWEEN ? AND ? AS IN_X_WINDOW`), outer query filters `WHERE any-flag` and COUNT_IFs each flag. NULL dates make flags NULL → COUNT_IF counts 0 and `TRUE OR NULL` keeps the row, so nothing in-window is lost.
- **GROUP BY (key, month/type)** replaces per-month/per-type scalars; read the result into a Map and treat missing keys as 0 (identical to the old scalar-0).
- **JS rollup replaces a coarser GROUP BY** only when each row maps to exactly one group in the finer level (dedup dimension: one row per development ⇒ summing a company's developments is integer-exact).
- **UNION ALL with a KIND tag** batches group-bys that need *different* date columns as the grouping timeline (monthly-by-ratified vs monthly-by-cancelled) into one round trip.
- **Reuse already-validated baselines** (e.g. funnel-ratio actuals from the headline counts) instead of re-running identical queries — legitimate only when predicates match exactly (default view = empty filter fragments).

**Gotchas:**
- Bind order follows SQL text order: subquery SELECT-list binds come **before** outer/appended WHERE-fragment binds. Getting this wrong silently produces wrong windows, not errors.
- A grouped scan emits 0-count groups the old per-metric queries never produced; consumers must treat 0 == missing (`.get(k) ?? 0` + skip `0==0` comparisons) or row-presence checks change behavior.
- Keep filter-fragment SQL aliases intact when wrapping a table in a subquery (alias the inner table with the fragment's expected alias).
- Today-dated-slice COUNT_IFs stay correct inside a wider either-window scan because a today-dated row is always inside its own YTD window.

**Why:** audit:all had grown to ~20 min of mostly rate-limit waiting; batching cut round trips ~3-4x per scenario with byte-identical check output.

**How to apply:** any new audit script (or new scenario) that would fire >3 scalar baselines against one table should start from these shapes; never weaken vacuity guards or label guards to batch them.
