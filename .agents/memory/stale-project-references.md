---
name: Stale TS project-reference declarations
description: Why typecheck can report missing @workspace/api-client-react exports that clearly exist in src
---

`pnpm run typecheck` in an artifact runs `tsc -p tsconfig.json --noEmit`, which does NOT rebuild referenced projects. Referenced libs (e.g. `lib/api-client-react`) are composite projects that emit declarations to `dist/`; tsc resolves imports against those built `.d.ts` files, not `src/`.

**Symptom:** `TS2305: Module '"@workspace/api-client-react"' has no exported member 'useGetX'` even though `src/generated/api.ts` exports it — the `dist/` declarations are stale (generated client was regenerated but declarations were not rebuilt).

**Fix:** `pnpm exec tsc -b lib/api-client-react` from the repo root, then re-run the artifact typecheck.

**How to apply:** whenever typecheck reports missing exports from a workspace lib that visibly exist in that lib's source, rebuild the lib with `tsc -b` before chasing phantom codegen problems.
