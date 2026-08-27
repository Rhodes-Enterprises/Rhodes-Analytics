---
name: Verifying AI-assisted rebase auto-merges
description: Auto-merges corrupt regions outside markers, drop/duplicate entrypoints, ship broken bases, and abort while you idle; verification checklist per round
---

# Trust nothing an auto-merge staged — verify against the clean sides

**Rule:** After any assisted rebase/merge round, don't just resolve the marked conflicts — diff the whole file against BOTH clean git sides (`git show :2:path` / `:3:path`) and explain every hunk as "mine" or "theirs"; anything unexplained is corruption. Mid-rebase, work that seems lost is usually in a commit still queued for replay — check the remaining todo before re-implementing (early re-implementation manufactures a self-conflict later).

**Why:** Corruption is silent — scrambled regions can parse, bundle, and even typecheck, and it also LANDS on main via merged siblings. A busy merge queue means the same file may conflict again minutes later against a newer main; each round must be re-verified from freshly extracted sides.

**How to apply, per round:** resolve markers → diff vs both sides, explain every hunk → typecheck + bundle + smoke-run past startup → continue only via the managed continue/abandon callbacks. Grep the FULL file for known signatures (below) — probing only the first N lines misses duplicates the auto-merge placed further down. Typecheck the BASE's own tree the moment conflicts appear: main's tip can itself be broken (once: four route handlers smeared into a fifth, tsc failing at HEAD in a file neither side touched); when the base is at fault, repair it inside the resolution from the last-intact commit plus the corrupting commit's *intended* pattern, and say so in the divergence summary.

**Assisted rebases can ABORT while you idle:** waiting minutes on background audits mid-resolution once ended with the platform resetting the branch, wiping working-tree resolutions and unstaged edits. Resolve fast, continue promptly; run long validations before triggering the merge or after it lands. Recovery: gitignored build output survives — `dist/*.map` `sourcesContent` holds resolved sources byte-exact; `git fsck --lost-found` may hold staged blobs.

## Known corruption signatures (all observed on this project)
- **Glued declaration:** a declaration lands on the END of a comment line (`// ...text.const X =`), commenting it out; the bundle is green and the script dies at runtime with a bare `X is not defined`. Scan comment lines for `\.(const|let|var|function) `.
- **Lost or duplicated entrypoint:** tail `main().catch(...)` dropped (audit defines everything, runs nothing, exits 0 — verify expected OUTPUT, not exit code), or two siblings independently restore it and a later round keeps BOTH (doubled runs + Snowflake traffic, first `process.exit` wins → nondeterministic). Check `grep -c '^main().catch'` == 1 per script; keep the one after ALL declarations (true EOF).
- **Reordered declarations:** merges can relocate a const (e.g. to EOF) leaving a mid-file entrypoint invocation before it — startup then reads TDZ/undefined values. The invocation must be the file's last statement.
- **Mixed helper generations:** one side's call sites grafted onto the other side's incompatible helper (closure vs Map API), duplicate top-level functions at EOF, helpers referenced but undefined ("X is not a function" minutes into a run). Enumerate every broken symbol at once with tsc on the script, diff declaration inventories vs last-good (`grep -oE '^(async )?function \w+'`), and reconcile call sites to ONE generation instead of patching one runtime explosion at a time.

## Post-rebase environment + sibling collisions
Run `pnpm install` after a rebase lands new deps — stale node_modules fails validation with ERR_MODULE_NOT_FOUND, "command not found", or a UI build's "Rollup failed to resolve import" on packages the rebased manifest declares. Expect semantic collisions between independently-green siblings (one adds UI rows, another's strict audit predates them; both merge cleanly, combined main fails). First-to-notice fixes forward; `git diff main..HEAD --stat` proves a failure is main-side, not yours.
