---
name: Stale TS project-reference declarations
description: Why typecheck can report missing @workspace/api-client-react exports that clearly exist in src
---

Artifact typechecks (`tsc -p tsconfig.json --noEmit`) do NOT rebuild referenced projects. Composite `lib/*` packages emit declarations to `dist/`, and tsc resolves `@workspace/*` imports against those built `.d.ts` files — not the lib's `src/`.

**Why:** after regenerating or editing a lib, its `dist/` declarations can lag its source, so downstream typechecks report exports as missing even though they visibly exist.

**How to apply:** when a typecheck claims a `@workspace/*` export doesn't exist but the lib's source clearly has it, rebuild that lib first (`tsc -b <lib path>` from the repo root) before chasing phantom codegen problems.
