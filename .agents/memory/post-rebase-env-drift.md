---
name: Post-rebase node_modules drift in task environments
description: After a task-completion rebase pulls dependency changes, node_modules lags the lockfile until pnpm install runs.
---

**Rule:** When a completion rebase pulls in other tasks' dependency changes, run pnpm install before expecting validation to pass.

**Why:** Task environments rebase onto main at completion, but nothing re-installs dependencies afterward. A validation command then fails with module-not-found for a package another task added — it exists in the merged lockfile but not in node_modules — so the tooling looks broken when the environment is merely stale. Diagnosing this cost a full validation cycle once.

**How to apply:** If a validation step fails almost instantly with ERR_MODULE_NOT_FOUND right after a rebase, sync dependencies and retry instead of debugging the failing script.
