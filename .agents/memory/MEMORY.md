# Memory Index

- [Snowflake connection quirks](snowflake-connection.md) — key normalization (bare base64 + passphrase), snowflake-sdk must stay esbuild-external, SELECT grants gotcha on PC_DBT_DB.DBT_ECORONADO.
- [DM_GOALS data model](goal-data-model.md) — daily-distributed goals, target→GOAL_TYPE naming, actual/channel/division definitions validated against Qlik; reuse for the other marketing dashboards.
- [Breakdown row seeding](goal-data-model.md) — breakdown tables must seed rows from actuals too, not just goals/GA rows, or developments with sales but no goals vanish silently (audit sum-check catches this).
