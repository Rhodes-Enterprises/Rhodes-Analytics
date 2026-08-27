---
name: Stale local build state (dist/, node_modules)
description: Why typecheck reports missing @workspace exports that exist in src, and why validations hit ERR_MODULE_NOT_FOUND after rebases
---

FIXED structurally (Aug 2026): every leaf `typecheck` script now runs `tsc -b <root solution tsconfig> && tsc -p tsconfig.json --noEmit`, so referenced libs are (re)built before the leaf check — no manual pre-build. Additionally each lib's `tsBuildInfoFile` is colocated at `dist/tsconfig.tsbuildinfo`: deleting `dist/` deletes the buildinfo with it, so a surviving buildinfo can no longer claim "up-to-date" while outputs are missing (verified: buildinfo at the old lib-root location + deleted dist made `tsc -b` no-op and `tsc -p` fail with TS6305).

**Why:** plain `tsc -p --noEmit` never rebuilds referenced projects; composite `lib/*` packages emit declarations to gitignored `dist/`, and project references redirect `@workspace/*` imports to those built `.d.ts` — so fresh clones and post-codegen states produced dozens of phantom "has no exported member" errors.

**How to apply:** if phantom missing-export errors ever return, suspect (a) a typecheck script regressed to bare `tsc -p`, (b) a new lib missing from root `tsconfig.json` references, or (c) a lib tsconfig without `tsBuildInfoFile` inside its `outDir`. Manual escape hatch remains `tsc -b --force` at repo root. Don't put `--force` in scripts: root typecheck fans leaf checks out in parallel, and concurrent forced lib rebuilds race on dist writes.

Same family: `node_modules` goes stale when a rebase pulls main forward — a sibling task's new dependency is in package.json AND pnpm-lock.yaml, but was never installed in THIS workspace, so scripts (and completion validations, which run here) die at import time with ERR_MODULE_NOT_FOUND in ~1s.

**How to apply:** an instant ERR_MODULE_NOT_FOUND for a dep that IS declared and locked means stale node_modules, not a broken manifest — run `pnpm install` at the repo root after any rebase that brought in other tasks' work, before debugging further.
