---
name: Verifying AI-assisted rebase auto-merges
description: Auto-merge conflict rounds can corrupt regions outside the markers and silently drop committed hunks; how to verify and repair
---

# Trust nothing an auto-merge staged — verify against the clean sides

**Rule:** After any assisted rebase/merge round, do not just resolve the marked conflicts. (1) Diff the whole working file against BOTH clean git sides (`git show HEAD:path`, `git show REBASE_HEAD:path`) — regions far from the markers can be scrambled (observed: four route handlers' lib calls all rewritten to a fifth handler's call; a script's tail truncated, dropping the `main().catch()` entrypoint so the audit "passed" vacuously by defining everything and running nothing — verify expected OUTPUT, not just exit code). When the sides' diff shows the files agree outside one block, rebuild the file from a clean side plus the intended block instead of patching the merged soup. (2) Mid-rebase, the working tree contains only the commits replayed SO FAR. A feature that seems missing (though the branch's final commit message claims it) is usually in a commit still queued for replay — check `git log REBASE_HEAD -1` and the remaining todo before concluding it was dropped. Re-implementing it early just manufactures a self-conflict when the real commit arrives, and the replayed original is often the more refined version.

**Why:** Both failure modes are silent: scrambled regions parse and typecheck can pass (or fail far from the real cause); and premature "recovery" work duplicates a queued commit, forcing another conflict round where you must re-merge against your own hasty copy.

**How to apply:** On every conflict round: resolve markers → `git diff` working vs each clean side → explain every hunk as either "mine" or "theirs" (anything unexplained is corruption) → if something committed seems lost, first check whether its commit is still queued → typecheck + run the touched audits before continuing the rebase.

**Post-rebase environment + sibling collisions:** After a rebase brings in new dependencies, run `pnpm install` before validating — stale node_modules fails scripts with ERR_MODULE_NOT_FOUND on packages the manifest already declares (cost: a full failed validation cycle). And expect semantic collisions between independently-green siblings: e.g. one task adds UI rows while another's strict UI-binding audit predates them — both merge cleanly, then the combined main fails validation for whoever validates next. First-to-notice fixes forward (register the new rows/labels in the audit); check `git diff main..HEAD --stat` to prove the collision is main-side, not yours.
