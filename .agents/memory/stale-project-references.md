---
name: Stale local build state (dist/, node_modules)
description: Why typecheck reports missing @workspace exports that exist in src, and why validations hit ERR_MODULE_NOT_FOUND after rebases
---

Artifact typechecks (`tsc -p tsconfig.json --noEmit`) do NOT rebuild referenced projects. Composite `lib/*` packages emit declarations to `dist/`, and tsc resolves `@workspace/*` imports against those built `.d.ts` files — not the lib's `src/`.

**Why:** after regenerating or editing a lib, its `dist/` declarations can lag its source, so downstream typechecks report exports as missing even though they visibly exist.

**How to apply:** when a typecheck claims a `@workspace/*` export doesn't exist but the lib's source clearly has it, rebuild that lib first (`tsc -b <lib path>` from the repo root) before chasing phantom codegen problems. If `tsc -b` exits 0 without rebuilding — a stale `tsconfig.tsbuildinfo` can claim up-to-date while `dist/` is still old — use `tsc -b --force`.

Same family: `node_modules` goes stale when a rebase pulls main forward — a sibling task's new dependency is in package.json AND pnpm-lock.yaml, but was never installed in THIS workspace, so scripts (and completion validations, which run here) die at import time with ERR_MODULE_NOT_FOUND in ~1s.

**How to apply:** an instant ERR_MODULE_NOT_FOUND for a dep that IS declared and locked means stale node_modules, not a broken manifest — run `pnpm install` at the repo root after any rebase that brought in other tasks' work, before debugging further.
