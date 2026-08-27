---
name: Task-env git is auto-checkpointed
description: Why git status shows clean despite local edits, and why `git checkout -- <path>` cannot revert your changes in task environments
---

# The working tree auto-checkpoints into HEAD — git cannot "undo" your edits

**Rule:** The platform continuously commits (checkpoints) your file edits, so HEAD tracks your latest edits on a short delay: `git status`/`git diff` read clean (or lag behind), and `git checkout -- <path>` restores a version that usually ALREADY CONTAINS the change you meant to discard — it exits 0 having reverted nothing (or discards only the newest not-yet-checkpointed edit, leaving earlier ones).

**Why:** A planted audit-trust mutation "reverted" with `git checkout --` silently stayed on disk through the next mutation's entire run, contaminating its evidence; it was caught only because the failure VALUES didn't match the single-mutation prediction. Exit code 0 and an empty diff proved nothing.

**How to apply:** Revert planted mutations / temporary edits by applying the reverse edit explicitly (Edit tool with the original text), never `git checkout -- <path>` / `git restore`. Verify a revert by re-reading the file region or diffing against an explicit old SHA (`git show <sha>:path | diff - path`), never by `git status` or exit codes. When a mutation run's failures don't match the single-mutation prediction, suspect a leftover earlier mutation first.

**Completion rebases eat FILE-TAIL hunks specifically:** an appended `main().catch(...)` entry-point was auto-resolved away by three consecutive completion rebases (each time silently — the script then defines everything, runs nothing, exits 0). Additions that must survive merges belong MID-FILE inside stable surrounding context (e.g. immediately after the function they invoke), not at the end of the file; re-grep for them after EVERY rebase before re-completing.
