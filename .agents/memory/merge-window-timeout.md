---
name: Managed merge-resolution windows time out
description: Platform aborts a stalled task-merge rebase; sequence resolution vs verification accordingly
---
The task-merge rebase window is short: if continueMergeResolution isn't called soon after conflicts appear, the platform aborts the rebase (reflog shows "rebase (abort)"), resets to the task branch, DROPS all in-progress conflict resolutions, and may add an empty auto-checkpoint commit on top. The task returns to IN_PROGRESS and must be re-completed (validation re-runs) before the merge is retried from scratch.

**Why:** Lost a fully-merged two-file resolution (Aug 2026) by restarting the dev server and running a ~4-min audit smoke-run inside the conflict window; every conflict round then had to be redone.

**How to apply:** Inside a conflict round do only: resolve files, quick typecheck/grep, continueMergeResolution — immediately. Do heavy verification (audit runs, workflow restarts) BEFORE markTaskComplete or AFTER the merge lands. If merged-tree verification matters, save the exact merged hunks (e.g. a patch under /tmp or notes) so a re-issued round is a 30-second replay, and run the audit after the rebase completes instead.
