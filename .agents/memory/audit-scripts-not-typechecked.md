---
name: Audit scripts typecheck
description: scripts/ now typechecked via a dedicated scripts tsconfig chained into the package typecheck; DOM lib for page.evaluate; what the net does and doesn't catch
---


# Audit scripts are typechecked (gap closed)

The api-server package has a second tsconfig (`tsconfig.scripts.json`,
include: ["scripts"], `lib: ["es2022","dom","dom.iterable"]`, own
tsBuildInfoFile ending in `.tsbuildinfo` so gitignore matches) chained into
the package's `typecheck` script after the src check. esbuild still does no
checking — the tsc pass is the only net over `scripts/`.

**Why:** the scripts dir used to be outside any tsconfig; three runtime
crashes (comment-glued `const` declaration, a function clobbered back to a
stale Map-returning version while call sites used the newer lookup-function
API, a deleted helper still called) sat in merged main invisibly because
only esbuild ever touched these files. The first scripts-wide tsc run
surfaced all three in seconds.

**How to apply:**
- New audit/helper scripts under `scripts/` are covered automatically
  (directory include). Scripts added OUTSIDE `scripts/`, or a new package's
  script dir, need the same treatment — a naked esbuild bundle step means
  zero checking.
- DOM code inside `page.evaluate` blocks typechecks because of the DOM lib —
  which also means node-side code referencing `document` would wrongly pass;
  keep browser-side code inside evaluate callbacks.
- The DOM lib resolved all of audit-ui's ~14 latent evaluate-block errors
  without typed wrappers.
- After rebases, `pnpm --filter @workspace/api-server run typecheck` now
  catches renamed/deleted helpers in scripts — run it before trusting a
  merged tree (supersedes the old "grep grafted call sites" advice, though a
  smoke run still catches value-level drift types can't see).
- Quick ONE-file scan when project refs aren't built (mid-rebase, dirty
  tree): `npx tsc --noEmit --skipLibCheck --module preserve
  --moduleResolution bundler --target es2022 scripts/audit-X.ts 2>&1 | grep
  "Cannot find name"` — finds every undefined identifier in ~30s with no
  Snowflake run.
- The net CANNOT see a dropped entry-point call: an uninvoked `main()` is
  legal TS, and the audit then passes vacuously (observed: a leasing audit
  "passing" in 0.5s with zero output). Trust a PASS only if the audit printed
  work; sub-second durations in the audit:all summary are the tell.
