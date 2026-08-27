---
name: Managed task-rebase hazards
description: Conflict-free auto-rebases can still break the tree; what to re-verify before re-completing
---

- A managed rebase that reports **no conflicts** can still be semantically broken: adjacent-line auto-merges may drop an import the other side added, or land an inserted block far from its intended position (e.g. after the script's top-level entry call, where a `let` is still uninitialized when first used under tsx's relaxed TDZ).
- Long-running workflows keep serving **pre-rebase code**; an audit or client built from the rebased tree then fails on missing response fields that look like real regressions.
- **How to apply:** after every rebase (managed or manual), before re-running validation or `markTaskComplete`: (1) re-run the root typecheck, (2) `git diff` the merge-touched files against the main ref when anything smells off, (3) restart affected workflows so processes match the tree.
- Rebases do NOT run pnpm install: if the incoming main changed pnpm-lock.yaml (new deps like playwright-core), run `pnpm install --frozen-lockfile` after the rebase or newly-required packages are missing at runtime.
