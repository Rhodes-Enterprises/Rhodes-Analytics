---
name: In-process audit patterns
description: Verifying cache-key agreement in one process (warm-up vs requests; clock-injected timezone-rollover binding via sentinel-seeded cache) and the script-bundle gotcha with workspace TS packages
---

# Warm-up vs request cache-key drift

**Rule:** Auditing "warm-up still pre-computes what real default requests read" must run in ONE process: run the REAL warm function (never a reimplementation), mount the REAL router at the real prefix, issue real HTTP requests, and observe every cache access via the shared observer hook. Emit from the query-cache FACTORY's request path (not from each lib's store) so every cache instance — present and future — is observed automatically; background revalidation must not emit. An externally running server cannot be audited for this — its warm-up ran at an unknown time — so the audit ignores AUDIT_API_BASE by design.

**Why:** Warm-up only helps if warm-phase keys byte-match request-phase keys (keys embed JSON.stringify of the filters object). Drift (handler injects a field, key shape changes, warm filters diverge) keeps warm-up "succeeding" while first visitors silently pay cold loads.

**How to apply:**
- Single source of truth: an exported table pairing each warm job with the default requestPath it pre-warms (WARMED_ENDPOINTS in the dashboards routes). Warm function and audit both iterate it, so new warmed endpoints are covered automatically.
- Pass criteria per endpoint: HTTP 200, zero misses, zero inflight-joins, AND at least one hit (zero accesses = handler uses an unobserved/private cache store — e.g. the leasing lib has its own store — or caching was removed; fail loudly either way).
- Vacuity guard on the warm phase: a cold process must produce >0 misses during warm, else the observer is disconnected.
- On failure, print each missed key next to the warm-phase key with the longest common prefix — makes the drifted field instantly visible.
- Date-derived keys (Chicago business day) legitimately diverge if the day rolls over mid-run: detect and retry the whole cycle once.
- Stale-while-revalidate caches: a stale serve is still an instant answer — observe it as a hit (the audit cares about cold foreground waits, not freshness). Long warm spans then can't cause false failures; only true absence misses.
- Transient upstream weather (the Snowflake proxy quota is shared across sibling task validations — 429 storms happen): if warm cycle 1 has failures, back off ~45s and run one full second warm cycle (warm keys answer instantly; only failures re-query). A phase-2 miss on an endpoint whose own warm job failed both cycles is a warm-QUERY failure — diagnose it as such, never as key drift.

## Clock-injected timezone-rollover checks (test Dec 31 any day)

**Rule:** Timezone-boundary behavior (day-scoped windows / cache keys rolling at business-timezone midnight) is testable offline any day: the single shared "today" helper takes an optional `now: Date`, and fixed-instant cases cover NYE ~11pm local (UTC already Jan 1; must stay OLD year), just past local midnight (must roll), an ordinary evening where UTC is already tomorrow, and both DST transitions. Each case declares which wrong impls it catches (pure UTC, frozen winter/summer offsets); verify the catch-table against simulated wrong impls in both directions so no case rots into vacuity.

**Why:** The wrongness is only observable in the evening window where UTC has rolled but local hasn't; scheduled audits at arbitrary hours would ship a silent UTC regression.

**How to apply:** Bind the REAL data function, not just a pure derivation, without the backing store: pre-seed the shared query cache with sentinels under the PREDICTED keys, observe cache accesses, call the real function with the fixed clock — pass = sentinel identity back + exactly one hit on the predicted key. When downstream math (quarter/year windows, clamps) is a pure function of the derived day string, verify its catch-table WITHOUT reimplementing that math: evaluate the REAL builder at an instant whose business-TZ day equals the wrong impl's day — 18:00Z is the same calendar day in both Chicago and UTC year-round (noon CST / 1pm CDT), so `new Date(day + "T18:00:00Z")` feeds any wrong "today" through production code exactly. Clear the backing store's config env before imports so key drift fails fast offline instead of querying; race with an unref'd timeout anyway. Add a src-wide single-definition guard (ban ad-hoc date/timezone formatting outside the helper module, with a vacuity check that the helper still owns it) so new code can't quietly fork "today".

## Script-bundle gotcha (esbuild --packages=external)

Audit scripts bundled with `--packages=external` cannot import anything that pulls `@workspace/*` packages whose exports point at `.ts` source (Node can't load TS, and under pnpm their transitive deps like zod are not resolvable from the consuming package). Fix: mount the specific router the audit needs instead of importing the full app (src/app pulls health routes → @workspace/api-zod), or alias the workspace package AND its transitive deps into the bundle. Also: set env vars (LOG_LEVEL etc.) before DYNAMIC imports of app modules — pino reads them at module init.
