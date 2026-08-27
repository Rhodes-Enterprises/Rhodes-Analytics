---
name: Chart-vs-table consistency nets & label-drift guards
description: Same-page chart/table agreement checks, and guards for audits that hardcode label literals
---

Dashboard pages here intentionally query the same numbers twice (a totals query and a monthly GROUP BY query). Nothing upstream forces the two to agree, so every such pair needs a same-response consistency check in the dashboard's audit script (Σ monthly == totals, per series).

**Why:** a change to one query silently desyncs the page — the chart disagrees with the table above it — and Snowflake baselines don't catch it when only one of the two surfaces is baseline-audited.

**How to apply:**
- Compare two aggregations of ONE API response, not two separate fetches.
- Use float-only tolerance (DM_GOALS daily-distributed goal sums carry ~1e-13 noise, e.g. 23.999999999999922 vs 23.99999999999992); the audit-wide percentage tolerance would mask real drift. NaN (renamed/missing field) must never pass.
- Add a vacuity guard: on scenarios whose data is known non-empty (default view, prior year), fail when every series compares 0 == 0 on both sides — that means the check verified nothing.
- Cover BOTH Online and Onsite channel filters: channel filters swap in per-channel goal types, so a regression can hit one channel only.
- Consistency-only variants are NOT enough for filter values that change semantics (per-channel goal types, opposite-channel-has-no-target): both API-derived series share a wrong goal-type resolution, so they agree while wrong. Such variants need real Snowflake baselines — scoped to the affected section (e.g. funnel-only) to keep query load down.
- Don't rely on a "busiest value" picker to visit semantic-bearing literal values: the busiest channel can be a third label (e.g. 'Unknown'), leaving Online AND Onsite unvisited. Pin literal-value variants explicitly.

## Label-domain drift guards (hardcoded-literal blind spot)

When an audit's baselines hardcode the SAME label literals the API keys on (channel 'Online'/'Onsite', GA property names, flag labels), an upstream rename zeroes BOTH sides and every per-cell check passes 0=0. Guard: a materially non-zero headline baseline whose expected-label baselines are ALL zero fails, naming the column, the expected labels, and the labels actually present (COALESCE(col,'(null)') GROUP BY, ordered by count). Quiet windows below the guard's min-total knob (default 10; channel guards share AUDIT_CHANNEL_GUARD_MIN_TOTAL, the GA property guard has AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL) are exempt.

**Why:** unlabeled rows legitimately make splits < total, but at volume they never take every split to exactly zero — that signature is label drift, not quiet data.

**How to apply:**
- The overview and leasing audits each run one (chLabels) on their default view; any new audit that binds hardcoded label literals into baselines needs one too.
- GA property renames are guarded centrally: scripts/ga-property-guard.ts (api-server) asserts every expected FCT_GOOGLE_ANALYTICS_EVENT_LEVEL.PROPERTY value ('Esperanza Homes', 'Rhodes Living') is present in a materially active window; audit-dashboard (default view) and audit-yoy (year to date) both run it. Extend its expected list when a dashboard starts depending on a new property. Literals still unguarded: IS_NEW_USER = 'Yes' (overview new-users), IS_SESSION_START = 'Yes' (leasing web traffic).
- Audits that pick filter values dynamically from the data (SELECT DISTINCT … ORDER BY count) are immune to renames — prefer that unless the API itself hardcodes the literal.
- UI-binding audits pin rendered row labels to API fields, so a task that adds or renames rendered rows MUST extend the binding contract in the same change — otherwise the break surfaces in the NEXT task's validation (the UI change and the audit merge separately, and audit:all fails for whoever validates after both land).
- To prove the FAIL path fires without touching source: build the audit bundle, sed the expected literals in the built .mjs (s/"Online"/"OnlineX"/g), run it, kill after the guard line prints. The data keeps real labels, the code expects wrong ones — the exact drift signature.
