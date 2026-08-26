---
name: Snowflake connection quirks
description: How the api-server talks to Snowflake (Replit connector) and schema/grant gotchas
---

- Snowflake access now goes through the **Replit Snowflake connector** (OAuth, `@replit/connectors-sdk` proxy to the SQL REST API `/api/v2/statements`), replacing the old key-pair snowflake-sdk setup. Token is scoped to `session:role:SYSADMIN`.
  **Why:** user prefers connector-managed credentials over hand-entered secrets.
  **How to apply:** all queries via `querySnowflake` in the api-server snowflake lib; it converts REST string cells by rowType (FIXED/REAL→number, DATE days-since-epoch→YYYY-MM-DD, TIMESTAMP seconds→ISO), binds `?` as positional bindings, handles 202 polling and partitions. Session context (database/schema/warehouse) must be sent uppercase in every request body — USE statements don't persist.
- Session context: warehouse PC_DBT_WH, db PC_DBT_DB, schema DBT_ECORONADO (env: SNOWFLAKE_DATABASE/SNOWFLAKE_SCHEMA shared env vars). Old key-pair secrets (SNOWFLAKE_ACCOUNT/USER/PRIVATE_KEY/…) are unused now.
- Gotcha: roles can SHOW tables in PC_DBT_DB.DBT_ECORONADO yet lack SELECT grants (tables owned by dbt users' roles). If queries 422 on access, an admin must GRANT SELECT ON ALL/FUTURE TABLES IN SCHEMA.
- Roles see the same data, but role changes can coincide with number changes for other reasons — check INFORMATION_SCHEMA.TABLES LAST_ALTERED before blaming the connection for a KPI shift (an Aug 2026 "drop" was actually a merged dedupe fix, not the connector).
- **Connector proxy rate limit: ~10 requests/second per repl** — bursts of parallel queries get HTTP 429 (`Rate limit exceeded: N/10 RPS for repl`, with Retry-After) and sporadic transient 500s (`Connection terminated due to connection timeout`).
  **Why:** discovered when boot-time cache warming fired ~14 concurrent statements; also explains sporadic 502s under parallel dashboard loads and audit runs.
  **How to apply:** the shared `proxyJson` transport in the snowflake lib retries 429s honoring Retry-After — keep that retry when touching the lib. Keep any new fan-out (warm-ups, endpoint queries) at or below ~7 concurrent statements or stagger it; batch/audit scripts should serialize their queries outright and retry their API fetches on 5xx, since a cold-cache endpoint can trip the same limit and surface as 502.
- The 10 RPS budget is **per repl, shared across parallel task validations**: when several tasks run their completion audits concurrently, sustained 12–20/10 RPS overloads exhaust even 5 retries and abort a run that is numerically fine. Signature: audit ERRORED on HTTP 429 (never a numeric FAIL), typically at the first cold-cache scenario fetch (server fan-out + audit baselines collide). A fully green in-session run plus 429-only validation aborts means infra contention, not wrong numbers — rerunning within the server cache TTL (~5 min) materially improves odds; further blind retries mostly add contention for everyone.
- Snowflake/proxy latency is heavy-tailed (same query 1s–7s run to run). To measure an endpoint perf change, interleave cold-start runs of both variants order-balanced and compare medians (n≥8 per variant); single-sample timings routinely point the wrong way.
- Verify endpoint: GET /api/snowflake/status (probe query returning session context or a clear error).
- Lesson: pnpm store contents can mask a missing package.json dependency — a dep can vanish from the manifest (e.g. in a merge) while dev still works. After merges, confirm snowflake-sdk is declared where it's imported.

## audit:all flakiness under concurrent task validations

The 10 RPS proxy budget is per REPL, shared by every concurrent process: task-merge validations each run audit:all, so when several tasks merge around the same time, audits 429 (one run showed 15/10 RPS while the largest single-audit burst is 11) or hit transient HTTP 500 "fetch failed" at arbitrary pre-existing query sites. Standalone reruns of the same audit pass.

**How to apply:** a validation-gate audit failure showing HTTP 429 or 500 at a scenario unrelated to your change is very likely contention, not regression — rerun the single audit standalone (boot dist/index.mjs on a private port, AUDIT_API_BASE=http://localhost:PORT/api) to confirm before touching code. Retry/backoff inside the audits is the durable fix (tracked as its own task).

