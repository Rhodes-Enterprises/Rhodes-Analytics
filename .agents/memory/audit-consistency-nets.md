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


## Audit query pacing: rate, not concurrency, is the constraint

The connector proxy limits query STARTS per second (~10 RPS repl-wide, shared with the API server), so concurrency caps and serialization do NOT protect an audit once Snowflake's result cache warms mid-run — COUNTs return in ~100ms and even a fully serialized loop exceeds 10 starts/sec.

**Why:** observed 15/10 RPS aborts with only 1–2 queries in flight; also the API server alone saturates the budget for ~a minute at a time (boot warm-up refills 11 views in ~54s; SWR background refreshes burst 14-wide), which outlasts the transport's ~15s of inner 429 retries.

**How to apply (both layers needed, in the audit script, wrapping/shadowing the shared query fn):**
- Enforce a minimum gap between query starts (150ms ≈ 6.7 RPS) regardless of batch shape.
- Add a few OUTER retries with long waits (10/20/30s — sized to outlast a warm-up window) for the transient signatures ONLY: HTTP 429 on direct queries, 502/503/429 on API fetches. Log every retry; let every other failure throw immediately so wrong numbers stay loud.

## Label-domain drift guards (hardcoded-literal blind spot)

When an audit's baselines hardcode the SAME label literals the API keys on (channel 'Online'/'Onsite', GA property names, flag labels), an upstream rename zeroes BOTH sides and every per-cell check passes 0=0. Guard: a materially non-zero headline baseline whose expected-label baselines are ALL zero fails, naming the column, the expected labels, and the labels actually present (COALESCE(col,'(null)') GROUP BY, ordered by count). Quiet windows below the guard's min-total knob (default 10; channel guards share AUDIT_CHANNEL_GUARD_MIN_TOTAL, the GA property guard has AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL) are exempt.

**Why:** unlabeled rows legitimately make splits < total, but at volume they never take every split to exactly zero — that signature is label drift, not quiet data.

**How to apply:**
- The overview and leasing audits each run one (chLabels) on their default view; any new audit that binds hardcoded label literals into baselines needs one too.
- One guard per CHANNEL COLUMN the page keys on, not per page: a single dashboard can split different cells on different tables' columns (deals-side vs contacts-side), and a guard on one column cannot see a rename on the other.
- When no headline baseline exists for a metric, one COALESCE(col,'(null)') GROUP BY probe doubles as count source and diagnostics: total = Σ all labels, expected labels = their rows, and the label list feeds the failure message with no second query.
- 'Unknown' is a real label in the channel columns (distinct from NULL); guards must not treat its presence as drift — only ALL expected labels at zero is the signature.
- GA property renames are guarded centrally: scripts/ga-property-guard.ts (api-server) asserts every expected FCT_GOOGLE_ANALYTICS_EVENT_LEVEL.PROPERTY value ('Esperanza Homes', 'Rhodes Living') is present in a materially active window; audit-dashboard (default view) and audit-yoy (year to date) both run it. Extend its expected list when a dashboard starts depending on a new property. Literals still unguarded: IS_NEW_USER = 'Yes' (overview new-users), IS_SESSION_START = 'Yes' (leasing web traffic).
- Audits that pick filter values dynamically from the data (SELECT DISTINCT … ORDER BY count) are immune to renames — prefer that unless the API itself hardcodes the literal.
- UI-binding audits pin rendered row labels to API fields, so a task that adds or renames rendered rows MUST extend the binding contract in the same change — otherwise the break surfaces in the NEXT task's validation (the UI change and the audit merge separately, and audit:all fails for whoever validates after both land).
- To prove the FAIL path fires without touching source: build the audit bundle, sed the expected literals in the built .mjs (s/"Online"/"OnlineX"/g, or a surgical target like labelCount("Online")), run it, kill after the guard line prints. The data keeps real labels, the code expects wrong ones — the exact drift signature. Setting AUDIT_CHANNEL_GUARD_MIN_TOTAL between two metrics' totals proves FAIL and quiet-window paths in one run.

- The UI-binding audit's maps (matrix rows, headers) must be EXTENDED in the same change that adds rows/columns to a dashboard — and tasks developed in parallel can each pass alone yet fail combined (one adds UI rows, the other rebased an audit map without them). The umbrella suite at completion validation is what surfaces this; when it fails, read the audit:all summary first — the failing audit may be cross-task drift, not the current task's change. Fix = teach the binding map the new rows (conditional presence if the section hides when empty), then mutation-test the new bindings.
  In a busy merge queue the same gap may get fixed independently on main while your merge waits; when main's fix is functionally equivalent, resolve conflicts by taking main's file VERBATIM (git checkout --ours during rebase-replay) so your commit stops touching the file — that ends repeat conflict rounds. Only favor your own version when it is strictly stricter/more faithful.

## Drill-down list vs bucket-count nets

A UI count and the record list that explains it must be one snapshot end to end: produce both from ONE SQL statement (UNION ALL with a row-kind discriminator), cache them as one entry, and ship them in the SAME response the count is rendered from — the drill-down UI then reads the already-loaded payload instead of fetching. Separate-endpoint or separate-statement designs leave races (data movement between statements, cache rotation between render and click) that make the reconciliation contract only statistically true — a reviewer will rightly reject that.

**Why:** the count and the list apply the same membership predicate in different languages (JS bucketing vs SQL WHERE); only same-statement + same-payload delivery reduces every possible mismatch to real predicate drift.

**How to apply:**
- Audit = pure in-response checks, no extra requests: list total == bucket count, each record satisfies predicate + date window, truncation contract (length == min(total, cap), truncated == total > length). Integer equality, no tolerance.
- Prove the net can fail: doctor the SQL predicate on a throwaway build and watch the in-response equality diverge.


## Running audits cleanly (rate-limit collisions)

Single audits against the long-lived dev server can false-fail: cache-expiry bursts plus page-load traffic blow the ~10 RPS proxy budget. For a clean signal use the all-audits command (fresh private server, warmed before audits start). It runs its audits SEQUENTIALLY and keeps going past failures — judge only by the final summary and wait for the process to EXIT; a second concurrent run collides on the private port and proxy budget and all-fails with bogus fetch errors. Fetch helpers that hit endpoints right after burst phases carry bounded transient retries (429/502/503 + connection errors); correctness failures must still fail immediately.
