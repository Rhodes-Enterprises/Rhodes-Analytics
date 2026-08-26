---
name: Chart-vs-table consistency nets
description: Same-page chart and table are fed by separate queries; how to audit that they agree
---

Dashboard pages here intentionally query the same numbers twice (a totals query and a monthly GROUP BY query). Nothing upstream forces the two to agree, so every such pair needs a same-response consistency check in the dashboard's audit script (Σ monthly == totals, per series).

**Why:** a change to one query silently desyncs the page — the chart disagrees with the table above it — and Snowflake baselines don't catch it when only one of the two surfaces is baseline-audited.

**How to apply:**
- Compare two aggregations of ONE API response, not two separate fetches.
- Use float-only tolerance (DM_GOALS daily-distributed goal sums carry ~1e-13 noise, e.g. 23.999999999999922 vs 23.99999999999992); the audit-wide percentage tolerance would mask real drift. NaN (renamed/missing field) must never pass.
- Add a vacuity guard: on scenarios whose data is known non-empty (default view, prior year), fail when every series compares 0 == 0 on both sides — that means the check verified nothing.
- Cover BOTH Online and Onsite channel filters: channel filters swap in per-channel goal types, so a regression can hit one channel only. Cheap consistency-only scenario variants (no Snowflake baselines) keep the extra coverage nearly free.
