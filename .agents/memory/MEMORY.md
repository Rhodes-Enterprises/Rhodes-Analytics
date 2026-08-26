# Memory Index

- [Snowflake connection quirks](snowflake-connection.md) — key normalization (bare base64 + passphrase), snowflake-sdk must stay esbuild-external, SELECT grants gotcha on PC_DBT_DB.DBT_ECORONADO.
- [DM_GOALS data model](goal-data-model.md) — daily-distributed goals, target→GOAL_TYPE naming, actual/channel/division definitions, breakdown row seeding; validated against Qlik. Reuse for the other marketing dashboards.
- [DM_COMPANY_DEVELOPMENT flags](dm-company-development-flags.md) — flags are labels ('Has Goals'/'Rental'), not Yes/No; dedup via IFF everywhere (DEV_DIM + audit mirrors move in lockstep).
- [Ratio goals & ratio audits](goal-data-model.md) — goal-ratio input table has junk NULL rows (filter year, skip nulls); resolve names both directions; audit derived ratios with compounded (1+t)/(1−t) tolerance.
