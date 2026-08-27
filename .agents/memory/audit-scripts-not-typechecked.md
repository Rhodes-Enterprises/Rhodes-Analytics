---
name: Audit scripts bypass tsc
description: scripts/ dir is outside tsconfig include; esbuild bundling does no type or symbol checking, so renamed helpers surface only at runtime
---

# Audit scripts are not typechecked

The api-server `tsconfig.json` has `include: ["src"]` — everything under
`scripts/` (the audit family) is **never** seen by `tsc`. The audit scripts
are built with esbuild (`--packages=external`), which does no type checking
and no cross-symbol validation: an undefined identifier survives bundling and
explodes only at runtime, potentially minutes into a Snowflake-heavy run.

**Why:** after a rebase, a helper was renamed on main (raw import aliased,
call sites moved to a retrying wrapper). Auto-merged sections from the task
branch still called the old name; `tsc --noEmit` was green, the audit bundled
fine, and the failure appeared 350s into the run as "querySnowflake is not
defined".

**How to apply:** after resolving rebase conflicts in `scripts/*.ts`, don't
trust a green typecheck. Grep the merged file for the identifiers your grafted
sections call (imports, shared helpers) and confirm each is still defined —
especially when main's commits mention renames, wrappers, or "shared helpers".
A cheap smoke check: `node --check` the bundled output or run the audit once
before completing.
