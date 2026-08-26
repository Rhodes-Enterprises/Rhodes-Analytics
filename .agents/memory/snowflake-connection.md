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
- Rate limit: the connector proxy enforces ~10 RPS per repl (HTTP 429 "Rate limit exceeded"); bursts from dashboards + audit/batch scripts together can also surface as 502s. The snowflake lib's `proxyJson` retries 429s with backoff — keep that retry when touching the lib. Batch/audit scripts must still serialize their queries (never parallel) and retry API fetches on 5xx, since a cold-cache endpoint can trip the same limit.
- Verify endpoint: GET /api/snowflake/status (probe query returning session context or a clear error).
- Lesson: pnpm store contents can mask a missing package.json dependency — a dep can vanish from the manifest (e.g. in a merge) while dev still works. After merges, confirm snowflake-sdk is declared where it's imported.
