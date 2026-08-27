---
name: Parallel-task merge hazards
description: What to check when rebasing onto main in this multi-agent repo — duplicate-fix stacking, helper renames, and why "typecheck green" doesn't cover audit scripts.
---

# Parallel-task merge hazards

Many agents work this repo concurrently, and two branches often fix the SAME gap
(e.g. both register a newly added dashboard row in an audit's binding map).

**Duplicate-fix stacking.** When both sides fixed the same thing in *different
spots* of a file, git auto-merges them WITHOUT a conflict and the result contains
both: duplicated type fields, double row registrations, two equivalent guards —
even two `main().catch(...)` entrypoint calls (both sides restored a dropped
entrypoint in different places), which makes the whole audit run twice
concurrently. `grep -c 'main().catch'` after every rebase touching a script.
After any rebase round, grep the touched files for the fix's key identifiers
(row labels, type field names) and count occurrences. A conditional
registration and an unconditional one are NOT equivalent — audit harnesses with
a "every binding must be rendered" completeness check false-fail on the
unconditional variant whenever the page hides the section.

**Helper renames on main.** Batching/refactor tasks rename baseline helpers.
If your guard's failure message or comments name helper functions, re-grep main's
merged tree for the current names before resolving — the conflict's "ours" side
usually shows the new ones.

**Same-named helpers with different contracts.** Two siblings can each
independently CREATE a helper with the same name (e.g. a batched
goal-baseline query) but different return types — one returns a lookup
function, the other a Map. The merge keeps ONE definition plus BOTH styles
of call site; since scripts/ bypass tsc, it only surfaces at runtime as
"X is not a function" mid-audit. Repair: `git log -S '<call-site text>'`
to find which commit authored each style, restore the dropped definition
verbatim from that commit (`git show <sha>:<file>`), and rename one of the
two helpers so both contracts coexist.

**Route/handler body grafts — main itself can be broken.** When two siblings
each rewrite every handler in a routes file (e.g. one adds a response envelope,
the other wraps every data call), their merge can pair handler BODIES with the
wrong route paths, duplicate some routes, and drop others entirely — producing
404s on dropped routes and instant 502s (ReferenceError) on mismatched ones.
Your completion validation then fails on damage you didn't cause. Triage fast:
(1) the audit's private-server boot log (/tmp/audit-all-server.log) shows the
real exception; (2) root `pnpm run typecheck` catches undefined-identifier
grafts in `src/` statically; (3) reconstruct from the pre-merge parent
(`git show <parent>:<file>`) plus one surviving-correct handler as the pattern
for the second sibling's transformation — never hand-guess bodies.
AND: as long as main still carries the damage, EVERY later rebase can re-mangle
your repaired file. Keep the verified-good copy reachable
(`git show <pre-rebase-head>:<file>` from the reflog), re-diff after each
rebase, and re-splice the good section instead of re-deriving it.

**Why:** both bit during one task's merge: stacked Unknown-row registrations +
a duplicated type field survived a "clean" auto-merge, and stale helper names
survived in a failure message.

**How to apply:** after each conflict round: (1) resolve markers, (2) grep for
stacked duplicates in files BOTH branches touched even if unconflicted,
(3) re-verify referenced helper names exist, (4) rebuild the audit bundles —
`pnpm typecheck` does NOT cover `scripts/` (tsconfig includes only `src`) and
esbuild does not typecheck, so duplicate identifiers in audit scripts surface
nowhere else.

**Stacked-generation helper loss:** when one branch REWRITES a helper's shape (e.g. Map-returning) while another branch keeps calling the OLD shape (lookup-function-returning), auto-merge keeps one definition + both call-site generations — un-typechecked audit scripts then die at runtime with "X is not a function"/"X is not defined" (a batching branch can also DELETE a helper a sibling still calls). Repair: git log -S the symbol, restore the historical definition under a distinct name (or verbatim if deleted), point the orphaned call sites at it, then tsc-scan the script standalone (--noEmit --skipLibCheck, ignore TS2307 module noise — TS2304 undefined-name is the signal) to find ALL such symbols before burning full audit runs one crash at a time.
