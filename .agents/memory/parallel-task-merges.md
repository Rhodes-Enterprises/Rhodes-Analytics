---
name: Parallel-task merge hazards
description: What to check when rebasing onto main in this multi-agent repo — duplicate-fix stacking, helper renames, and why "typecheck green" doesn't cover audit scripts.
---

# Parallel-task merge hazards

Many agents work this repo concurrently, and two branches often fix the SAME gap
(e.g. both register a newly added dashboard row in an audit's binding map).

**Duplicate-fix stacking.** When both sides fixed the same thing in *different
spots* of a file, git auto-merges them WITHOUT a conflict and the result contains
both: duplicated type fields, double row registrations, two equivalent guards.
After any rebase round, grep the touched files for the fix's key identifiers
(row labels, type field names) and count occurrences. A conditional
registration and an unconditional one are NOT equivalent — audit harnesses with
a "every binding must be rendered" completeness check false-fail on the
unconditional variant whenever the page hides the section.

**Helper renames on main.** Batching/refactor tasks rename baseline helpers.
If your guard's failure message or comments name helper functions, re-grep main's
merged tree for the current names before resolving — the conflict's "ours" side
usually shows the new ones.

**Why:** both bit during one task's merge: stacked Unknown-row registrations +
a duplicated type field survived a "clean" auto-merge, and stale helper names
survived in a failure message.

**How to apply:** after each conflict round: (1) resolve markers, (2) grep for
stacked duplicates in files BOTH branches touched even if unconflicted,
(3) re-verify referenced helper names exist, (4) rebuild the audit bundles —
`pnpm typecheck` does NOT cover `scripts/` (tsconfig includes only `src`) and
esbuild does not typecheck, so duplicate identifiers in audit scripts surface
nowhere else.
