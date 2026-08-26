---
name: Audit tolerance conventions
description: How dashboard audits set divergence tolerances against cached endpoints
---

- When an audit compares a same-day-cached endpoint (e.g. per-UTC-day cache keys) against fresh Snowflake baselines, do NOT use exact equality or a flat absolute tolerance. Bound each value by the cache-consistent window: `baseline − todayStampedCount − slack ≤ api ≤ baseline + slack`, where todayStampedCount is fetched per row alongside the baseline (one `COUNT_IF(dateCol = today)` in the same GROUP BY) and slack = max(2, TOLERANCE_PCT% of baseline) absorbs rare restatements of past days.
  **Why:** the cache legitimately lags today's activity by up to a day; exact checks flake on busy afternoons, while flat floors are either flaky in January (small YTD, hot day) or too loose to catch small real regressions. The window stays tight when a row had no activity today (the common case) and is independent of cache TTL details — which other tasks keep changing.
  **How to apply:** reuse when adding per-row numeric audits for any other cached dashboard endpoint (leasing, funnel, etc.). Real join regressions (zeroed, duplicated, cross-wired counts) blow far past the window. Reference implementation: the Community List YTD section of the dashboard audit script.
- Verify new audit checks can actually FAIL: run the audit once through a tiny local proxy that forwards to the real server but doctors the one response under test (inflate one value, zero another), and confirm exactly the expected FAIL lines + exit 1. Cheap, needs no code changes to the audit or server.
